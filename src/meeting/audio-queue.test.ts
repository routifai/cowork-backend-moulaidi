import { describe, expect, it } from "vitest";
import { AudioQueue } from "./audio-queue.js";

async function collect(queue: AudioQueue): Promise<Buffer[]> {
	const chunks: Buffer[] = [];
	for await (const chunk of queue) chunks.push(chunk);
	return chunks;
}

describe("AudioQueue", () => {
	it("yields chunks pushed before consumption starts", async () => {
		const queue = new AudioQueue();
		queue.push(Buffer.from([1]));
		queue.push(Buffer.from([2]));
		queue.close();

		expect(await collect(queue)).toEqual([Buffer.from([1]), Buffer.from([2])]);
	});

	it("yields chunks pushed after consumption has started waiting", async () => {
		const queue = new AudioQueue();
		const resultPromise = collect(queue);

		await new Promise((resolve) => setTimeout(resolve, 0));
		queue.push(Buffer.from([9]));
		queue.close();

		expect(await resultPromise).toEqual([Buffer.from([9])]);
	});

	it("ends iteration on close with no pending chunks", async () => {
		const queue = new AudioQueue();
		queue.close();
		expect(await collect(queue)).toEqual([]);
	});

	it("drops pushes after close", async () => {
		const queue = new AudioQueue();
		queue.close();
		queue.push(Buffer.from([1]));
		expect(await collect(queue)).toEqual([]);
	});
});
