/** Run `worker` over `items` with at most `limit` in flight at once, preserving result order. */
export async function runWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function runNext(): Promise<void> {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	}

	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => runNext());
	await Promise.all(workers);
	return results;
}
