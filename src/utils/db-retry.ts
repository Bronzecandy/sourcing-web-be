import { logDiag, logDbError } from "./process-diagnostics";
import { classifyPgError, serializePgError } from "./pg-error";
import {
  CrawlDbUnavailableError,
  isConnectionDeadError,
  noteCrawlDbFailure,
  noteCrawlDbSuccess,
  throwIfCrawlDbCircuitOpen,
} from "./crawl-db-circuit";

export { isConnectionDeadError, CrawlDbUnavailableError };

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
    msg.includes("timeout expired") ||
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
  throwIfCrawlDbCircuitOpen();
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const delayMs = Math.max(100, options.delayMs ?? 3000);

  let lastErr: unknown;
  let attemptCap = maxAttempts;
  for (let attempt = 1; attempt <= attemptCap; attempt++) {
    try {
      const result = await fn();
      noteCrawlDbSuccess();
      return result;
    } catch (err: unknown) {
      lastErr = err;
      if (err instanceof CrawlDbUnavailableError) {
        throw err;
      }
      if (!isRetryableDbError(err)) {
        logDbError("db-query-failed", err, { label, attempt, retryable: false });
        throw err;
      }
      // Dead replica / timed-out pool: 5 × 60s connect stalls every tab. Fail over to stale cache.
      if (isConnectionDeadError(err)) {
        attemptCap = Math.min(attemptCap, 2);
      }
      if (attempt >= attemptCap) {
        noteCrawlDbFailure(err);
        logDbError("db-retry-exhausted", err, { label, attempt, maxAttempts: attemptCap });
        throw err;
      }
      logDiag("db-retry", {
        label,
        attempt,
        maxAttempts: attemptCap,
        dbKind: classifyPgError(err),
        ...serializePgError(err),
      });
      const wait = isConnectionDeadError(err) ? Math.min(delayMs, 1000) : delayMs * attempt;
      const code = errorCode(err) ?? "unknown";
      console.warn(
        `[db-retry] ${label} attempt ${attempt}/${attemptCap} failed (${code}), retrying in ${wait}ms...`,
      );
      await sleep(wait);
    }
  }
  throw lastErr ?? new Error("unreachable");
}
