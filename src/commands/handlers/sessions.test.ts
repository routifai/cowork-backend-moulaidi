import { describe, expect, it, vi, beforeEach } from "vitest";
import * as protocol from "../../protocol.js";
import { handleNewSession } from "./sessions.js";
import type { HandlerDependencies } from "../handler-registry.js";

// handleNewSession dynamically imports both of these; vi.mock intercepts the
// dynamic import the same way it would a static one.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	SessionManager: {
		create: vi.fn(() => ({ getSessionFile: () => "/tmp/fake-session.jsonl" })),
	},
	createAgentSession: vi.fn(async () => ({ session: { abort: vi.fn() } })),
}));

vi.mock("../../prompt-runner.js", () => ({ subscribeSession: vi.fn() }));

vi.mock("../../agent-init.js", () => ({
	resolveWorkspace: vi.fn((cwd: string | undefined) => cwd ?? "/default/cwd"),
	defaultWorkspaceDir: () => "/default/cwd",
	piAgentDir: () => "/pi/agent/dir",
	buildResourceLoader: vi.fn(async () => ({ reload: vi.fn() })),
}));

const noop = () => {};

function mockDeps(workspaceCwd: string, resourceLoaderReload = vi.fn()): HandlerDependencies {
	return {
		initialized: true,
		modelRegistry: {} as any,
		session: { abort: vi.fn() } as any,
		modelRuntime: {},
		settingsManager: {},
		sessionManager: {},
		resourceLoader: { reload: resourceLoaderReload },
		workspaceCwd,
		hypatiaDir: "/hypatia-dir",
		promptScheduler: { schedule: () => {} },
		initAgent: async () => {},
		buildResourceLoader: async () => ({}),
		bindExtensionUi: async () => {},
		resolveUiResponse: noop,
		setInitialized: noop,
		setSession: noop,
		setSessionManager: noop,
		setResourceLoader: vi.fn(),
		setWorkspaceCwd: vi.fn(),
	};
}

describe("handleNewSession", () => {
	beforeEach(() => {
		vi.spyOn(protocol, "send").mockImplementation(() => {});
	});

	it("reloads the existing resource loader when the new session stays in the same workspace — this is what picks up project memory saved since the loader was last built (regression: a brand-new session in the same folder used to silently keep a stale, pre-memory system prompt)", async () => {
		const reload = vi.fn(async () => {});
		const deps = mockDeps("/Users/simo/project", reload);

		await handleNewSession(deps, { type: "new_session", id: "n1", cwd: "/Users/simo/project" });

		expect(reload).toHaveBeenCalledOnce();
		expect(deps.setResourceLoader).not.toHaveBeenCalled();
	});

	it("rebuilds the resource loader (rather than reloading the old one) when the new session targets a different workspace", async () => {
		const reload = vi.fn(async () => {});
		const deps = mockDeps("/Users/simo/project", reload);

		await handleNewSession(deps, { type: "new_session", id: "n2", cwd: "/Users/simo/other-project" });

		expect(deps.setResourceLoader).toHaveBeenCalledOnce();
		expect(reload).not.toHaveBeenCalled();
	});
});
