export async function mapWithConcurrency(items, limit, worker, onProgress) {
  const source = Array.from(items || []);
  if (!source.length) return [];
  const workerCount = Math.max(1, Math.min(source.length, Math.floor(Number(limit) || 1)));
  const results = new Array(source.length);
  let nextIndex = 0;
  let completed = 0;

  async function runWorker() {
    while (nextIndex < source.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status:"fulfilled", value:await worker(source[index], index) };
      } catch (reason) {
        results[index] = { status:"rejected", reason };
      }
      completed += 1;
      onProgress?.({ completed, total:source.length, index, result:results[index] });
    }
  }

  await Promise.all(Array.from({ length:workerCount }, () => runWorker()));
  return results;
}

export function canStartConcurrentJob(activeIds, jobId, limit) {
  const active = activeIds instanceof Set ? activeIds : new Set(activeIds || []);
  const maximum = Math.max(1, Math.floor(Number(limit) || 1));
  return Boolean(jobId) && !active.has(jobId) && active.size < maximum;
}
