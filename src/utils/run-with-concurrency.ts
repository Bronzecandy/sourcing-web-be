/** Chạy task async với giới hạn song song (tránh tràn pool DB). */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const cap = Math.max(1, Math.min(limit, tasks.length));
  const results = new Array<T>(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]!();
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}
