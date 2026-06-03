import { cache } from "./cache";
import { pool } from "./prisma";
import { classifyPgError, serializePgError } from "./pg-error";

const ENABLED = process.env.DIAG_LOGS !== "0";
const VERBOSE = process.env.DIAG_VERBOSE === "1";

export function isDiagVerbose(): boolean {
  return VERBOSE;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function memorySnapshot(): Record<string, string> {
  const m = process.memoryUsage();
  return {
    heapUsed: mb(m.heapUsed),
    heapTotal: mb(m.heapTotal),
    rss: mb(m.rss),
    external: mb(m.external),
    arrayBuffers: mb(m.arrayBuffers),
  };
}

function poolSnapshot(): Record<string, number> {
  return {
    poolTotal: pool.totalCount,
    poolIdle: pool.idleCount,
    poolWaiting: pool.waitingCount,
  };
}

function cacheSnapshot(): Record<string, number> {
  return { cacheKeys: cache.keys().length };
}

/** Structured one-line diagnostic for server debugging (OOM vs DB vs crash). */
export function logDiag(
  event: string,
  detail: Record<string, string | number | boolean | null | undefined> = {},
): void {
  if (!ENABLED) return;
  const payload = {
    event,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    ...memorySnapshot(),
    ...poolSnapshot(),
    ...cacheSnapshot(),
    nodeOptions: process.env.NODE_OPTIONS ?? "(unset)",
    ...detail,
  };
  console.log("[diag]", JSON.stringify(payload));
}

/** Chi tiết từng batch / query — chỉ khi DIAG_VERBOSE=1. */
export function logDiagVerbose(
  event: string,
  detail: Record<string, string | number | boolean | null | undefined> = {},
): void {
  if (!ENABLED || !VERBOSE) return;
  logDiag(event, detail);
}

/** Mốc quan trọng — không kèm pool/memory (tránh spam khi gọi dày). */
export function logDiagBrief(
  event: string,
  detail: Record<string, string | number | boolean | null | undefined> = {},
): void {
  if (!ENABLED) return;
  console.log(
    "[diag]",
    JSON.stringify({
      event,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      ...detail,
    }),
  );
}

export function serializeErr(err: unknown): Record<string, string | undefined> {
  const e = err as {
    code?: string;
    message?: string;
    meta?: { code?: string; message?: string };
    cause?: { code?: string; message?: string };
  };
  const cause = e.cause;
  return {
    code: e.code ?? e.meta?.code ?? cause?.code,
    message: (e.message ?? e.meta?.message ?? String(err)).slice(0, 800),
    causeCode: cause?.code,
    causeMessage: cause?.message?.slice(0, 400),
  };
}

export function logDbError(
  event: string,
  err: unknown,
  extra: Record<string, string | number | boolean | null | undefined> = {},
): void {
  if (!ENABLED) return;
  logDiag(event, {
    dbKind: classifyPgError(err),
    ...serializePgError(err),
    ...extra,
  });
}

export function logDiagError(
  event: string,
  err: unknown,
  extra?: Record<string, string | number | boolean>,
): void {
  logDbError(event, err, extra ?? {});
}

export function installProcessDiagnostics(): void {
  if (!ENABLED) {
    console.log("[diag] disabled (set DIAG_LOGS=0 to hide; unset or DIAG_LOGS=1 to enable)");
    return;
  }

  logDiag("process-boot", {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  });

  process.on("uncaughtException", (err) => {
    logDiagError("uncaughtException", err);
  });

  process.on("unhandledRejection", (reason) => {
    logDiagError("unhandledRejection", reason);
  });

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      logDiag("signal", { signal: sig });
    });
  }

  process.on("exit", (code) => {
    // sync log on exit
    if (ENABLED) {
      console.log(
        "[diag]",
        JSON.stringify({
          event: "process-exit",
          exitCode: code,
          pid: process.pid,
          uptimeSec: Math.round(process.uptime()),
          ...memorySnapshot(),
          ...cacheSnapshot(),
        }),
      );
    }
  });
}
