import { afterEach, describe, expect, it, vi } from "vitest";
import { initDb, closeDb } from "../db/index.js";
import { saveGeneratedPresentation } from "../db/presentation-store.js";
import { handlePresentingPing } from "../commands/ping.js";
import { handlePresentingGetPresentation } from "../commands/get-presentation.js";

vi.mock("../../protocol.js", () => {
	const sent: unknown[] = [];
	return {
		send: (msg: unknown) => {
			sent.push(msg);
		},
		log: () => {},
		logError: () => {},
		logWarn: () => {},
		__sent: sent,
	};
});

async function sentMessages(): Promise<unknown[]> {
	const protocol = await import("../../protocol.js");
	return (protocol as unknown as { __sent: unknown[] }).__sent;
}

describe("presenting commands", () => {
	afterEach(() => {
		closeDb();
	});

	it("ping returns pong", async () => {
		const sent = await sentMessages();
		sent.length = 0;
		await handlePresentingPing({ id: "p1" });
		expect(sent.at(-1)).toMatchObject({
			type: "result",
			id: "p1",
			data: { pong: true },
		});
	});

	it("get_presentation returns a frontend-shaped deck", async () => {
		initDb();
		const id = saveGeneratedPresentation(
			{
				title: "Deck",
				template: "general",
				language: "English",
				slides: [{ layout: "title", content: { title: "Hi" }, ui: { id: "title" } }],
			},
			() => ({ layouts: [{ id: "title", components: [] }] }),
		);

		const sent = await sentMessages();
		sent.length = 0;
		await handlePresentingGetPresentation({ id: "g1", presentationId: id });
		const msg = sent.at(-1) as { type: string; data: Record<string, unknown> };
		expect(msg.type).toBe("result");
		expect(msg.data.presentation_id).toBe(id);
		expect(msg.data.template).toBe("general");
		expect(msg.data.n_slides).toBe(1);
		expect(Array.isArray(msg.data.slides)).toBe(true);
	});
});
