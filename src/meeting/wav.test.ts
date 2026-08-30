import { describe, expect, it } from "vitest";
import { pcm16leRms, pcm16leToWav } from "./wav.js";

describe("pcm16leToWav", () => {
	it("produces a well-formed RIFF/WAVE header for mono 16-bit PCM", () => {
		const pcm = Buffer.from(new Int16Array([100, -200, 300, -400]).buffer);
		const wav = pcm16leToWav(pcm, 16_000);

		expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
		expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
		expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
		expect(wav.readUInt16LE(20)).toBe(1); // PCM
		expect(wav.readUInt16LE(22)).toBe(1); // mono
		expect(wav.readUInt32LE(24)).toBe(16_000); // sample rate
		expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
		expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
		expect(wav.readUInt32LE(40)).toBe(pcm.length);
		expect(wav.length).toBe(44 + pcm.length);
	});
});

describe("pcm16leRms", () => {
	it("returns 0 for silence", () => {
		const pcm = Buffer.alloc(320); // 160 zeroed samples
		expect(pcm16leRms(pcm)).toBe(0);
	});

	it("returns close to 1 for a full-scale square wave", () => {
		const samples = new Int16Array(100).fill(32767);
		const pcm = Buffer.from(samples.buffer);
		expect(pcm16leRms(pcm)).toBeGreaterThan(0.99);
	});

	it("returns 0 for an empty buffer", () => {
		expect(pcm16leRms(Buffer.alloc(0))).toBe(0);
	});
});
