import { describe, expect, it, vi, beforeEach } from "vitest";
import * as protocol from "../../protocol.js";
import { handleNewSession } from "./sessions.js";
import type { HandlerDependencies } from "../handler-registry.js";
import type { SessionState } from "../../app/session-state.js";

// handleNewSession dynamically imports both of these; vi.mock intercepts the
// dynamic import the same way it would a static one.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	SessionManager: {
		create: vi.fn(() => ({ getSessionFile: () => "/tmp/fake-session.jsonl" })),
	},
	createAgentSession: vi.fn(async () => ({ session: { abort: vi.fn(), subscribe: vi.fn() } })),
}));

const buildResourceLoaderMock = vi.fn(async (_cwd: string, _hypatiaDir: string, _settings: unknown) => ({
	reload: vi.fn(),
}));

vi.mock("../../agent-init.js", () => ({
	resolveWorkspace: vi.fn((cwd: string | undefined) => cwd ?? "/default/cwd"),
	defaultWorkspaceDir: () => "/default/cwd",
	piAgentDir: () => "/pi/agent/dir",
	buildResourceLoader: (cwd: string, hypatiaDir: string, settings: unknown) =>
		buildResourceLoaderMock(cwd, hypatiaDir, settings),
}));

const noop = () => {};

function mockDeps(overrides: Partial<HandlerDependencies> = {}): HandlerDependencies {
	return {
		initialized: true,
		modelRegistry: {} as any,
		session: undefined,
		modelRuntime: {},
		settingsManager: {},
		workspaceCwd: "/Users/simo/project",
		hypatiaDir: "/hypatia-dir",
		getSession: () => undefined,
		addSession: vi.fn(),
		removeSession: noop,
		listSessionIds: () => [],
		activeSessionId: undefined,
		setActiveSessionId: vi.fn(),
		initAgent: async () => {},
		buildResourceLoader: async () => ({}),
		bindExtensionUi: vi.fn(async () => {}),
		resolveUiResponse: noop,
		setInitialized: noop,
		...overrides,
	};
}

describe("handleNewSession", () => {
	beforeEach(() => {
		vi.spyOn(protocol, "send").mockImplementation(() => {});
		buildResourceLoaderMock.mockClear();
	});

	it("always builds a fresh resource loader for the new session — resourceLoader is duplicated per session, never reused, so a brand-new session's system prompt always reflects up-to-date project memory/instructions", async () => {
		const deps = mockDeps();

		await handleNewSession(deps, { type: "new_session", id: "n1", cwd: "/Users/simo/project" });

		expect(buildResourceLoaderMock).toHaveBeenCalledOnce();
	});

	it("builds a fresh loader even when the requested workspace matches an existing session's — no shared/reused loader across sessions", async () => {
		const deps = mockDeps();

		await handleNewSession(deps, { type: "new_session", id: "n2", cwd: "/Users/simo/other-project" });

		expect(buildResourceLoaderMock).toHaveBeenCalledOnce();
		expect(buildResourceLoaderMock).toHaveBeenCalledWith(
			"/Users/simo/other-project",
			"/hypatia-dir",
			deps.settingsManager,
		);
	});

	it("regression: creating a new session never touches a different, already-tracked session's AgentSession — the actual bug being fixed (previously: a new chat aborted whatever was already running)", async () => {
		const existingAbort = vi.fn();
		const existing: SessionState = {
			id: "existing-session-id",
			session: { abort: existingAbort } as any,
			sessionManager: {} as any,
			resourceLoader: {} as any,
			workspaceCwd: "/Users/simo/project",
			promptScheduler: { schedule: () => {} } as any,
			promptRunner: { subscribeSession: noop, runPromptTask: async () => {} } as any,
			createdAt: 0,
			lastActivity: 0,
		};
		const deps = mockDeps({
			activeSessionId: existing.id,
			getSession: (id: string) => (id === existing.id ? existing : undefined),
		});

		await handleNewSession(deps, { type: "new_session", id: "n3", cwd: "/Users/simo/project" });

		expect(existingAbort).not.toHaveBeenCalled();
		expect(deps.addSession).toHaveBeenCalledOnce();
		expect(deps.setActiveSessionId).toHaveBeenCalledWith("/tmp/fake-session.jsonl");
	});
});
