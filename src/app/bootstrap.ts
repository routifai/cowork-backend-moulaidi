import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createHandler, type HandlerDependencies } from "../commands/handler-registry.js";
import type { Command } from "../commands/types.js";
import {
	buildResourceLoader,
	cleanStaleLocks,
	defaultHypatiaDir,
	ensureDir,
	HYPATIA_SYSTEM_PROMPT,
	piAgentDir,
	PROVIDER_REQUEST_TIMEOUT_MS,
	resolveWorkspace,
} from "../agent-init.js";
import { applyBundledNpm } from "../agent/npm-bundling.js";
import { activateBundledBinaries } from "../bundled-binaries.js";
import { bindExtensionUi, resolveUiResponse } from "../extension-ui-bridge.js";
import { createPromptScheduler } from "../prompt-scheduler.js";
import { readPiPackages } from "../disk-extension-loader.js";
import { createPromptRunner } from "../prompt-runner.js";
import { log, send } from "../protocol.js";
import type { AppContainer } from "./container.js";
import type { SessionState } from "./session-state.js";

const EMBEDDED_ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || "__ANTHROPIC_API_KEY__").trim();

export interface BootstrappedApp {
	container: AppContainer;
	handleCommand: (cmd: Command) => Promise<void>;
}

export async function bootstrapApp(): Promise<BootstrappedApp> {
	log("Sidecar starting (pid=%s)", process.pid);

	const container: AppContainer = {
		initialized: false,
		modelRuntime: undefined,
		modelRegistry: undefined,
		settingsManager: undefined,
		hypatiaDir: defaultHypatiaDir(),
		sessions: new Map<string, SessionState>(),
		activeSessionId: undefined,
	};

	/** The active session's SessionState, or undefined before first init. */
	function activeSession(): SessionState | undefined {
		return container.activeSessionId ? container.sessions.get(container.activeSessionId) : undefined;
	}

	/**
	 * Full process (re)bootstrap: rebuilds modelRuntime/modelRegistry/
	 * settingsManager and creates ONE fresh session, replacing every
	 * previously-tracked session. This mirrors the pre-multi-session
	 * behavior exactly (reload always meant "start over completely") —
	 * fixing its blast radius to spare other live sessions is Phase 5 of
	 * docs/plans/multi-session-concurrency.md, explicitly deferred.
	 */
	async function initAgent(hypatiaDirPath: string, workspace?: string) {
		container.hypatiaDir = hypatiaDirPath || defaultHypatiaDir();
		activateBundledBinaries();

		const workspaceCwd = resolveWorkspace(workspace, container.hypatiaDir);
		log("Workspace cwd: %s", workspaceCwd);

		const piDir = piAgentDir();
		ensureDir(piDir);
		const authPath = join(piDir, "auth.json");
		const modelsPath = join(piDir, "models.json");
		cleanStaleLocks(piDir);

		container.modelRuntime = await ModelRuntime.create({ authPath, modelsPath });
		if (EMBEDDED_ANTHROPIC_KEY && !EMBEDDED_ANTHROPIC_KEY.startsWith("__ANTHROPIC_API_KEY__")) {
			await container.modelRuntime.setRuntimeApiKey("anthropic", EMBEDDED_ANTHROPIC_KEY);
		}
		container.modelRegistry = new ModelRegistry(container.modelRuntime);

		container.settingsManager = SettingsManager.inMemory({
			retry: { provider: { timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS, maxRetries: 3 } },
		});
		const piPackages = readPiPackages(piDir);
		if (piPackages.length > 0) container.settingsManager.setPackages(piPackages);

		applyBundledNpm(container.settingsManager);

		// Mutable box shared with the resource loader's getEnabledConnectorIds
		// closure — see app/session-state.ts's mcpConnectorIds doc comment.
		const mcpConnectorIds: { current: Set<string> | undefined } = { current: undefined };
		const resourceLoader = await buildResourceLoader(
			workspaceCwd,
			container.hypatiaDir,
			container.settingsManager,
			{ getEnabledConnectorIds: () => mcpConnectorIds.current },
		);

		const sessionManager = SessionManager.create(workspaceCwd);
		const result = await createAgentSession({
			cwd: workspaceCwd,
			modelRuntime: container.modelRuntime,
			sessionManager,
			settingsManager: container.settingsManager,
			resourceLoader,
		});
		const session = result.session;
		// Session id = the pi session file path — already the identity the
		// frontend treats a session by. Falls back to a random id in the rare
		// case a session has no backing file (e.g. an in-memory session).
		const id = sessionManager.getSessionFile() ?? randomUUID();

		const coworkActivePath = join(workspaceCwd, ".pi", "cowork_active");
		try {
			writeFileSync(coworkActivePath, `${process.pid}`, "utf-8");
		} catch {
			// best-effort
		}

		const promptRunner = createPromptRunner(id);
		promptRunner.subscribeSession(session);
		await bindExtensionUi(session, id);

		// A full (re)init always replaces every tracked session — see doc
		// comment above.
		container.sessions.clear();
		container.sessions.set(id, {
			id,
			session,
			sessionManager,
			resourceLoader,
			workspaceCwd,
			promptScheduler: createPromptScheduler(),
			promptRunner,
			createdAt: Date.now(),
			lastActivity: Date.now(),
			mcpConnectorIds,
		});
		container.activeSessionId = id;
		container.initialized = true;

		const available = await container.modelRegistry.getAvailable();
		const models = available.map((m) => ({
			id: m.id,
			name: m.name,
			provider: m.provider,
			reasoning: m.reasoning,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		}));

		const providerMap = new Map<string, { id: string; modelCount: number }>();
		for (const m of available) {
			const p = m.provider;
			const existing = providerMap.get(p) ?? { id: p, modelCount: 0 };
			existing.modelCount++;
			providerMap.set(p, existing);
		}

		send({
			type: "ready",
			models,
			providers: Array.from(providerMap.values()),
			activeModel: session.model
				? {
						provider: session.model.provider,
						id: session.model.id,
						name: session.model.name,
					}
				: null,
			thinkingLevel: session.thinkingLevel ?? null,
		});
		log("Sidecar ready — %d models available", models.length);
	}

	const deps: HandlerDependencies = {
		get initialized() {
			return container.initialized;
		},
		get modelRegistry() {
			return container.modelRegistry!;
		},
		get modelRuntime() {
			return container.modelRuntime;
		},
		get settingsManager() {
			return container.settingsManager;
		},
		get hypatiaDir() {
			return container.hypatiaDir;
		},
		get session() {
			return activeSession()?.session;
		},
		get workspaceCwd() {
			return activeSession()?.workspaceCwd ?? resolveWorkspace(undefined, container.hypatiaDir);
		},
		getSession: (id: string) => container.sessions.get(id),
		addSession: (state: SessionState) => {
			container.sessions.set(state.id, state);
		},
		removeSession: (id: string) => {
			container.sessions.delete(id);
		},
		listSessionIds: () => [...container.sessions.keys()],
		get activeSessionId() {
			return container.activeSessionId;
		},
		setActiveSessionId: (id: string | undefined) => {
			container.activeSessionId = id;
		},
		initAgent,
		bindExtensionUi,
		resolveUiResponse,
		buildResourceLoader: async (cwd: string, opts?: any) => {
			return buildResourceLoader(cwd, container.hypatiaDir, container.settingsManager!, opts);
		},
		setInitialized: (v: boolean) => {
			container.initialized = v;
		},
	};

	const handleCommand = createHandler(deps);

	return { container, handleCommand };
}
