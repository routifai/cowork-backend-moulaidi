import { describe, expect, it, vi } from "vitest";
import * as protocol from "../../protocol.js";
import { handleCompleteModelCall } from "./core.js";
import type { HandlerDependencies } from "../handler-registry.js";

const noop = () => {};

function mockDeps(overrides: Partial<HandlerDependencies> = {}): HandlerDependencies {
	return {
		initialized: true,
		modelRegistry: {} as any,
		session: undefined,
		modelRuntime: {},
		settingsManager: {},
		workspaceCwd: "/Users/simo/project",
		hypatiaDir: "/tmp/hypatia-test",
		getSession: () => undefined,
		addSession: noop,
		removeSession: noop,
		listSessionIds: () => [],
		activeSessionId: undefined,
		setActiveSessionId: noop,
		initAgent: async () => {},
		buildResourceLoader: async () => ({}),
		bindExtensionUi: async () => {},
		resolveUiResponse: noop,
		setInitialized: noop,
		...overrides,
	};
}

describe("handleCompleteModelCall", () => {
	it("resolves the model via modelRegistry.find and calls modelRuntime.completeSimple, not any AgentSession turn", async () => {
		const messages: unknown[] = [];
		vi.spyOn(protocol, "send").mockImplementation((msg: unknown) => {
			messages.push(msg);
		});

		const found = { id: "claude-x", provider: "anthropic" };
		const find = vi.fn().mockReturnValue(found);
		const completeSimple = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "pong" }] });

		const deps = mockDeps({
			modelRegistry: { find } as any,
			modelRuntime: { completeSimple },
		});

		await handleCompleteModelCall(deps, {
			type: "complete_model_call",
			id: "c1",
			provider: "anthropic",
			model: "claude-x",
			systemPrompt: "be terse",
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		});

		expect(find).toHaveBeenCalledWith("anthropic", "claude-x");
		expect(completeSimple).toHaveBeenCalledWith(found, {
			systemPrompt: "be terse",
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			tools: undefined,
		});
		expect(messages.at(-1)).toMatchObject({
			type: "result",
			id: "c1",
			data: { content: [{ type: "text", text: "pong" }] },
		});
	});

	it("does not require a session — never calls getSession/resolveTargetSession machinery", async () => {
		vi.spyOn(protocol, "send").mockImplementation(noop);
		const getSession = vi.fn();
		const deps = mockDeps({
			modelRegistry: { find: () => ({ id: "m" }) } as any,
			modelRuntime: { completeSimple: async () => ({}) },
			getSession,
		});

		await handleCompleteModelCall(deps, {
			type: "complete_model_call",
			id: "c2",
			provider: "anthropic",
			model: "m",
			messages: [],
		});

		expect(getSession).not.toHaveBeenCalled();
	});

	it("sends an error when the model is not found", async () => {
		const messages: unknown[] = [];
		vi.spyOn(protocol, "send").mockImplementation((msg: unknown) => {
			messages.push(msg);
		});
		const deps = mockDeps({
			modelRegistry: { find: () => undefined } as any,
			modelRuntime: { completeSimple: vi.fn() },
		});

		await handleCompleteModelCall(deps, {
			type: "complete_model_call",
			id: "c3",
			provider: "anthropic",
			model: "does-not-exist",
			messages: [],
		});

		expect(messages.at(-1)).toMatchObject({
			type: "error",
			id: "c3",
			message: "Model anthropic/does-not-exist not found",
		});
	});

	it("sends an error when not initialized (no modelRegistry/modelRuntime)", async () => {
		const messages: unknown[] = [];
		vi.spyOn(protocol, "send").mockImplementation((msg: unknown) => {
			messages.push(msg);
		});
		const deps = mockDeps({ modelRegistry: undefined as any, modelRuntime: undefined });

		await handleCompleteModelCall(deps, {
			type: "complete_model_call",
			id: "c4",
			provider: "anthropic",
			model: "m",
			messages: [],
		});

		expect(messages.at(-1)).toMatchObject({ type: "error", id: "c4", message: "Not initialized" });
	});

	it("catches a completeSimple rejection and reports it as a protocol error, not an unhandled rejection", async () => {
		const messages: unknown[] = [];
		vi.spyOn(protocol, "send").mockImplementation((msg: unknown) => {
			messages.push(msg);
		});
		const deps = mockDeps({
			modelRegistry: { find: () => ({ id: "m" }) } as any,
			modelRuntime: { completeSimple: vi.fn().mockRejectedValue(new Error("provider timeout")) },
		});

		await handleCompleteModelCall(deps, {
			type: "complete_model_call",
			id: "c5",
			provider: "anthropic",
			model: "m",
			messages: [],
		});

		expect(messages.at(-1)).toMatchObject({ type: "error", id: "c5", message: "provider timeout" });
	});
});
