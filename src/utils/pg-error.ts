type PgErrShape = {
  code?: string;
  severity?: string;
  detail?: string;
  hint?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  constraint?: string;
  routine?: string;
  message?: string;
  meta?: { code?: string; message?: string };
  cause?: unknown;
};

/** Flatten node-pg / Prisma errors into fields useful for DBA tickets. */
export function serializePgError(err: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const seen = new Set<unknown>();
  let depth = 0;

  for (let cur: unknown = err; cur && depth < 4 && !seen.has(cur); depth++) {
    seen.add(cur);
    const e = cur as PgErrShape;
    const prefix = depth === 0 ? "pg" : `pgCause${depth}`;

    const code = e.code ?? e.meta?.code;
    if (code && !out.pgCode) out.pgCode = code;
    if (code) out[`${prefix}Code`] = code;

    const msg = e.message ?? e.meta?.message;
    if (msg && depth === 0) out.message = msg.slice(0, 800);
    if (msg) out[`${prefix}Message`] = msg.slice(0, 400);

    for (const [field, key] of [
      ["severity", "Severity"],
      ["detail", "Detail"],
      ["hint", "Hint"],
      ["where", "Where"],
      ["schema", "Schema"],
      ["table", "Table"],
      ["column", "Column"],
      ["constraint", "Constraint"],
      ["routine", "Routine"],
    ] as const) {
      const val = e[field];
      if (val && !out[`pg${key}`]) out[`pg${key}`] = String(val).slice(0, 500);
    }

    cur = e.cause;
  }

  return out;
}

/** Short label — maps PG/Prisma codes to likely root cause. */
export function classifyPgError(err: unknown): string {
  const pg = serializePgError(err);
  const code = pg.pgCode ?? pg.pgCause1Code;
  const msg = (pg.message ?? "").toLowerCase();

  if (code === "40001" || msg.includes("conflict with recovery")) return "replica_recovery_conflict";
  if (code === "40P01" || msg.includes("deadlock")) return "deadlock";
  if (code === "P2034" || msg.includes("write conflict")) return "prisma_write_conflict";
  if (code === "22P05" || msg.includes("unicode escape")) return "invalid_unicode_in_json";
  if (code === "57014" || msg.includes("statement timeout") || msg.includes("query_canceled")) {
    return "query_timeout_or_canceled";
  }
  if (code === "57P03" || code === "53300") return "db_unavailable_or_connection_limit";
  if (code === "P1008" || code === "P2024" || msg.includes("timed out")) return "connection_timeout";
  if (msg.includes("econnreset") || msg.includes("connection terminated")) return "connection_dropped";
  return "other_db_error";
}
