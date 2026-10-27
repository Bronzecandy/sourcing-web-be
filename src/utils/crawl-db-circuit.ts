import pg from "pg";
import { classifyPgError } from "./pg-error";

export class CrawlDbUnavailableError extends Error {
  constructor(message = "Crawl database is unreachable") {
    super(message);
    this.name = "CrawlDbUnavailableError";
  }
}

let openedAt = 0;
let consecutiveFails = 0;

export function isCrawlDbCircuitOpen(): boolean {
  return openedAt > 0;
}

export function isConnectionDeadError(err: unknown): boolean {
  if (err instanceof CrawlDbUnavailableError) return true;
  const kind = classifyPgError(err);
  return (
    kind === "connection_timeout" ||
    kind === "connection_dropped" ||
    kind === "db_unavailable_or_connection_limit"
  );
}

export function noteCrawlDbSuccess(): void {
  consecutiveFails = 0;
  openedAt = 0;
}

export function noteCrawlDbFailure(err?: unknown): void {
  if (err && !isConnectionDeadError(err)) return;
  consecutiveFails += 1;
  if (consecutiveFails >= 2 || err instanceof CrawlDbUnavailableError) {
    openedAt = Date.now();
    console.warn("[crawl-db] circuit open — skip crawl queries, use cache/TapTap until replica recovers");
  }
}

export function openCrawlDbCircuit(reason: string): void {
  const wasOpen = openedAt > 0;
  openedAt = Date.now();
  consecutiveFails = 2;
  if (!wasOpen) {
    console.warn(`[crawl-db] circuit open (${reason}) — until replica probe succeeds`);
  }
}

export function throwIfCrawlDbCircuitOpen(): void {
  if (isCrawlDbCircuitOpen()) {
    throw new CrawlDbUnavailableError();
  }
}

export async function startCrawlDbProbeLoop(intervalMs = 60_000): Promise<void> {
  await probeCrawlDb();
  setInterval(() => {
    void probeCrawlDb();
  }, intervalMs);
}

/** Fast probe so requests do not wait on a dead replica. */
export async function probeCrawlDb(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;
    const client = new pg.Client({
      connectionString,
      connectionTimeoutMillis: 3_000,
    });
  try {
    await client.connect();
    await client.query("SELECT 1");
    const wasOpen = openedAt > 0;
    noteCrawlDbSuccess();
    if (wasOpen) console.log("[crawl-db] probe ok — circuit closed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    openCrawlDbCircuit(`probe failed: ${message.slice(0, 120)}`);
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}
