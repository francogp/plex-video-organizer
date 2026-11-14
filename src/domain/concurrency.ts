/**
 * Runs up to `concurrency` parallel workers across `items`, passing `(item, index, slot)`
 * to `workerFn` until all items are processed or `isCancelled?.()` returns `true`.
 */
export async function runSlotWorkerPool<T>(
  items: readonly T[],
  concurrency: number,
  workerFn: (item: T, index: number, slot: number) => Promise<void>,
  isCancelled?: () => boolean
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  const worker = async (slot: number): Promise<void> => {
    while (cursor < items.length && !isCancelled?.()) {
      const idx = cursor;
      cursor += 1;
      await workerFn(items[idx]!, idx, slot);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, async (_, slot) => worker(slot)));
}
