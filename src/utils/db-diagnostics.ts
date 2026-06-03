import { logDiag, logDbError } from "./process-diagnostics";
import { withDbRetry, type DbRetryOptions } from "./db-retry";

export { logDbError };

const slowMs = Math.max(0, parseInt(process.env.DB_LOG_SLOW_MS ?? "3000", 10) || 3000);
const logAllOk = process.env.DB_LOG_ALL === "1";

/**
 * Run a crawl-DB query with retry, timing, and rich PG error logging.
 */
export async function runDbQuery<T>(
  label: string,
  fn: () => Promise<T>,
  extra?: Record<string, string | number | boolean | null | undefined>,
  retryOptions?: DbRetryOptions,
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await withDbRetry(fn, label, retryOptions);
    const durationMs = Date.now() - t0;
    if (logAllOk || durationMs >= slowMs) {
      logDiag("db-query-ok", { label, durationMs, ...extra });
    }
    return result;
  } catch (err) {
    logDbError("db-query-failed", err, { label, durationMs: Date.now() - t0, ...extra });
    throw err;
  }
}
