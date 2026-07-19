/**
 * Serializes prompt execution WITHOUT blocking the caller.
 *
 * The sidecar's stdin read loop must not block while a prompt is generating.
 * If it did (the original bug: `await session.prompt()` inline in the
 * `for await (line of rl)` loop), an `abort` command — delivered over stdin —
 * could not be read until the prompt finished, making "Stop" a no-op
 * mid-generation and queuing the next prompt behind the 10-minute auto-abort.
 *
 * This scheduler lets the loop fire-and-forget a prompt task:
 *  - `schedule()` returns immediately (never blocks the loop), and
 *  - tasks run one-at-a-time in submission order, so two `session.prompt()`
 *    calls never overlap (overlap throws "Agent is already processing"), and
 *  - a thrown task never breaks the chain for later prompts.
 */
export interface PromptScheduler {
	/**
	 * Enqueue a task. Returns synchronously; the task runs after every
	 * previously-scheduled task has settled. `onError` receives any rejection
	 * so it can't break the chain for subsequent tasks.
	 */
	schedule(task: () => Promise<void>, onError?: (err: unknown) => void): void;
	/** Resolves once all currently-scheduled tasks have settled (tests/shutdown). */
	idle(): Promise<void>;
}

export function createPromptScheduler(): PromptScheduler {
	let chain: Promise<void> = Promise.resolve();

	return {
		schedule(task, onError) {
			chain = chain
				.then(task)
				.catch((err: unknown) => {
					onError?.(err);
				});
		},
		idle() {
			return chain;
		},
	};
}
