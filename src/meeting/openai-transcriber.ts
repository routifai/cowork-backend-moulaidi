/**
 * openai-transcriber — buffers incoming PCM16 audio chunks and flushes a
 * WAV-wrapped blob to OpenAI's `/v1/audio/transcriptions` (Whisper) on a
 * simple RMS-silence heuristic, or once the buffer gets too long. Each
 * flushed chunk's transcription is appended as a "final" segment — this is
 * near-live (chunked every few seconds of speech), not truly incremental
 * within a chunk, which is the tradeoff for using OpenAI's plain REST
 * endpoint instead of a streaming API.
 */

import OpenAI from "openai";
import { pcm16leRms, pcm16leToWav } from "./wav.js";
import { log, logWarn } from "../protocol.js";

const SILENCE_RMS_THRESHOLD = 0.01;
const FLUSH_AFTER_SILENCE_MS = 800;
const MAX_BUFFER_MS = 20_000;
const CHUNK_DURATION_MS = 100; // matches the Rust capture loop's chunk cadence

export interface Transcriber {
	pushChunk(pcm16le: Buffer): void;
	stop(): Promise<void>;
}

export function createOpenAiTranscriber(opts: {
	apiKey: string;
	sampleRate: number;
	onTranscript: (text: string, isFinal: boolean) => void;
}): Transcriber {
	const client = new OpenAI({ apiKey: opts.apiKey });
	let buffered: Buffer[] = [];
	let bufferedMs = 0;
	let hasSpeech = false;
	let silenceMs = 0;
	let flushing: Promise<void> = Promise.resolve();
	let stopped = false;

	function flush(): void {
		if (buffered.length === 0) return;
		const pcm = Buffer.concat(buffered);
		buffered = [];
		bufferedMs = 0;
		hasSpeech = false;
		silenceMs = 0;

		flushing = flushing.then(async () => {
			try {
				const wav = pcm16leToWav(pcm, opts.sampleRate);
				const file = await OpenAI.toFile(wav, "chunk.wav", { type: "audio/wav" });
				const result = await client.audio.transcriptions.create({
					file,
					model: "whisper-1",
				});
				const text = result.text?.trim();
				if (text) opts.onTranscript(text, true);
			} catch (err) {
				logWarn("openai-transcriber: chunk transcription failed: %s", err instanceof Error ? err.message : String(err));
			}
		});
	}

	return {
		pushChunk(pcm16le: Buffer) {
			if (stopped) return;
			buffered.push(pcm16le);
			bufferedMs += CHUNK_DURATION_MS;

			const rms = pcm16leRms(pcm16le);
			if (rms > SILENCE_RMS_THRESHOLD) {
				hasSpeech = true;
				silenceMs = 0;
			} else if (hasSpeech) {
				silenceMs += CHUNK_DURATION_MS;
			}

			if (hasSpeech && (silenceMs >= FLUSH_AFTER_SILENCE_MS || bufferedMs >= MAX_BUFFER_MS)) {
				flush();
			}
		},
		async stop() {
			stopped = true;
			flush();
			await flushing;
			log("openai-transcriber: stopped");
		},
	};
}
