/**
 * audio-queue — a tiny async-iterable queue bridging incoming
 * `meeting_audio_chunk` wire commands (pushed one at a time as they arrive)
 * to a consumer that wants an `AsyncIterable<Buffer>` (AWS Transcribe
 * Streaming's `AudioStream` input shape).
 */

export class AudioQueue implements AsyncIterable<Buffer> {
	private buffered: Buffer[] = [];
	private waiting: ((value: IteratorResult<Buffer>) => void)[] = [];
	private closed = false;

	push(chunk: Buffer): void {
		if (this.closed) return;
		const resolve = this.waiting.shift();
		if (resolve) {
			resolve({ value: chunk, done: false });
		} else {
			this.buffered.push(chunk);
		}
	}

	close(): void {
		this.closed = true;
		for (const resolve of this.waiting.splice(0)) {
			resolve({ value: undefined, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<Buffer> {
		return {
			next: (): Promise<IteratorResult<Buffer>> => {
				const chunk = this.buffered.shift();
				if (chunk) return Promise.resolve({ value: chunk, done: false });
				if (this.closed) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => this.waiting.push(resolve));
			},
		};
	}
}
