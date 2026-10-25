/**
 * Runs `task` for every item, at most `limit` at a time, and never rejects:
 * one failing item doesn't stop the others. Batches keep providers with rate
 * limits from getting every request at once.
 */
export async function mapSettled<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    results.push(...(await Promise.allSettled(batch.map(task))));
  }
  return results;
}
