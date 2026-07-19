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
import { subscribeSession } from "../prompt-runner.js";
import { log, send } from "../protocol.js";
import type { AppContainer } from "./container.js";

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
		sessionManager: undefined,
		settingsManager: undefined,
		session: undefined,
		resourceLoader: undefined,
		hypatiaDir: defaultHypatiaDir(),
		workspaceCwd: resolveWorkspace(undefined, defaultHypatiaDir()),
		promptScheduler: createPromptScheduler(),
	};

	async function initAgent(hypatiaDirPath: string, workspace?: string) {
		container.hypatiaDir = hypatiaDirPath || defaultHypatiaDir();
		activateBundledBinaries();

		if (workspace !== undefined) {
			container.workspaceCwd = resolveWorkspace(workspace, container.hypatiaDir);
		}
		log("Workspace cwd: %s", container.workspaceCwd);

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

		container.resourceLoader = await buildResourceLoader(
			container.workspaceCwd,
			container.hypatiaDir,
			container.settingsManager,
		);

		container.sessionManager = SessionManager.create(container.workspaceCwd);
		const result = await createAgentSession({
			cwd: container.workspaceCwd,
			modelRuntime: container.modelRuntime,
			sessionManager: container.sessionManager,
			settingsManager: container.settingsManager,
			resourceLoader: container.resourceLoader,
		});
		container.session = result.session;

		const coworkActivePath = join(container.workspaceCwd, ".pi", "cowork_active");
		try {
			writeFileSync(coworkActivePath, `${process.pid}`, "utf-8");
		} catch {
			// best-effort
		}

		subscribeSession(container.session);
		await bindExtensionUi(container.session);

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
			activeModel: container.session?.model
				? {
						provider: container.session.model.provider,
						id: container.session.model.id,
						name: container.session.model.name,
					}
				: null,
			thinkingLevel: container.session?.thinkingLevel ?? null,
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
		get session() {
			return container.session;
		},
		get modelRuntime() {
			return container.modelRuntime;
		},
		get settingsManager() {
			return container.settingsManager;
		},
		get sessionManager() {
			return container.sessionManager;
		},
		get resourceLoader() {
			return container.resourceLoader;
		},
		get hypatiaDir() {
			return container.hypatiaDir;
		},
		get workspaceCwd() {
			return container.workspaceCwd;
		},
		get promptScheduler() {
			return container.promptScheduler;
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
		setSession: (s: any) => {
			container.session = s;
		},
		setSessionManager: (sm: any) => {
			container.sessionManager = sm;
		},
		setResourceLoader: (rl: any) => {
			container.resourceLoader = rl;
		},
		setWorkspaceCwd: (cwd: string) => {
			container.workspaceCwd = cwd;
		},
	};

	const handleCommand = createHandler(deps);

	return { container, handleCommand };
}
