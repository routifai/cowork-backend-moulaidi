/**
 * aws-transcriber — opens ONE `StartStreamTranscriptionCommand` for the
 * whole recording session and feeds it PCM16 frames as they arrive via an
 * `AudioQueue`. Reads back `TranscriptEvent`s in a background loop, calling
 * `onTranscript` for each result (partial results too — AWS's own
 * incremental-refinement model, unlike OpenAI's per-chunk-final approach).
 */

import {
	TranscribeStreamingClient,
	StartStreamTranscriptionCommand,
	type AudioStream,
} from "@aws-sdk/client-transcribe-streaming";
import { AudioQueue } from "./audio-queue.js";
import type { Transcriber } from "./openai-transcriber.js";
import { log, logWarn } from "../protocol.js";

export function createAwsTranscriber(opts: {
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	sampleRate: number;
	onTranscript: (text: string, isFinal: boolean) => void;
}): Transcriber {
	const queue = new AudioQueue();
	const client = new TranscribeStreamingClient({
		region: opts.region,
		credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
	});

	async function* audioStream(): AsyncGenerator<AudioStream> {
		for await (const chunk of queue) {
			yield { AudioEvent: { AudioChunk: chunk } };
		}
	}

	const readLoop = (async () => {
		try {
			const response = await client.send(
				new StartStreamTranscriptionCommand({
					LanguageCode: "en-US",
					MediaEncoding: "pcm",
					MediaSampleRateHertz: opts.sampleRate,
					AudioStream: audioStream(),
				}),
			);
			for await (const event of response.TranscriptResultStream ?? []) {
				const results = event.TranscriptEvent?.Transcript?.Results ?? [];
				for (const result of results) {
					const text = result.Alternatives?.[0]?.Transcript?.trim();
					if (text) opts.onTranscript(text, !result.IsPartial);
				}
			}
		} catch (err) {
			logWarn("aws-transcriber: stream failed: %s", err instanceof Error ? err.message : String(err));
		}
	})();

	return {
		pushChunk(pcm16le: Buffer) {
			queue.push(pcm16le);
		},
		async stop() {
			queue.close();
			await readLoop;
			client.destroy();
			log("aws-transcriber: stopped");
		},
	};
}
