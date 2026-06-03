const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorCode(err: unknown): string | undefined {
  const e = err as {
    code?: string;
    meta?: { code?: string; message?: string };
    cause?: unknown;
  };
  return e.code ?? e.meta?.code;
}

function errorMessage(err: unknown): string {
  const e = err as { message?: string; meta?: { message?: string } };
  return String(e.message ?? e.meta?.message ?? "");
}

/** Transient Postgres / Prisma errors (replica recovery, deadlock, timeout). */
export function isRetryableDbError(err: unknown): boolean {
  if (!err) return false;

  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err && isRetryableDbError(cause)) return true;

  const code = errorCode(err);
  const msg = errorMessage(err).toLowerCase();

  if (
    code === "40001" ||
    code === "40P01" ||
    code === "57P03" ||
    code === "P2034" ||
    code === "P1008" ||
    code === "P2024"
  ) {
    return true;
  }

  return (
    msg.includes("conflict with recovery") ||
    msg.includes("canceling statement due to conflict") ||
    msg.includes("deadlock") ||
    msg.includes("write conflict") ||
    msg.includes("could not serialize") ||
    msg.includes("timed out") ||
    msg.includes("timeout exceeded") ||
    msg.includes("sockettimeout") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("connection terminated")
  );
}

export type DbRetryOptions = {
  maxAttempts?: number;
  delayMs?: number;
};

/**
 * Retry read/query operations against crawl DB (often a hot standby replica).
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  label: string,
  options: DbRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const delayMs = Math.max(100, options.delayMs ?? 3000);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      if (!isRetryableDbError(err) || attempt === maxAttempts) throw err;
      const wait = delayMs * attempt;
      const code = errorCode(err) ?? "unknown";
      console.warn(
        `[db-retry] ${label} attempt ${attempt}/${maxAttempts} failed (${code}), retrying in ${wait}ms...`,
      );
      await sleep(wait);
    }
  }
  throw lastErr ?? new Error("unreachable");
}
