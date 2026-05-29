/** One-off: inspect AppRank.raw for appId (argv). Usage: npx tsx src/scripts/inspect-app-raw.ts 755604 */
import "../load-env";
import { prisma } from "../utils/prisma";

function walk(obj: unknown, path = ""): string[] {
  const hits: string[] = [];
  if (obj === null || obj === undefined) return hits;
  if (typeof obj === "string") {
    if (obj.includes("网易") || obj.includes("NetEase")) hits.push(`${path}=${JSON.stringify(obj.slice(0, 120))}`);
    return hits;
  }
  if (Array.isArray(obj)) {
    obj.forEach((x, i) => hits.push(...walk(x, `${path}[${i}]`)));
    return hits;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      hits.push(...walk(v, path ? `${path}.${k}` : k));
    }
  }
  return hits;
}

async function main() {
  const appId = parseInt(process.argv[2] ?? "755604", 10);
  const row = await prisma.appRank.findFirst({
    where: { appId },
    orderBy: { date: "desc" },
  });
  if (!row) {
    console.log("No AppRank row for appId", appId);
    return;
  }
  console.log("appId:", row.appId, "date:", row.date.toISOString());
  const raw = row.raw;
  if (!raw || typeof raw !== "object") {
    console.log("raw empty");
    return;
  }
  const topKeys = Object.keys(raw as object);
  console.log("Top-level keys:", topKeys.slice(0, 40).join(", "));
  const hits = walk(raw);
  console.log("\nPaths containing 网易 / NetEase:");
  hits.forEach((h) => console.log(" ", h));

  const r = raw as Record<string, unknown>;
  console.log("\ndeveloper:", JSON.stringify(r.developer));
  console.log("publisher:", JSON.stringify(r.publisher));
  console.log("developers:", JSON.stringify(r.developers)?.slice(0, 500));

  const stat = (r.stat && typeof r.stat === "object" ? r.stat : null) as Record<string, unknown> | null;
  if (stat) {
    console.log("\nstat keys:", Object.keys(stat).join(", "));
    console.log("hits_total:", stat.hits_total);
    console.log("download_count:", stat.download_count);
    console.log("reserve_count:", stat.reserve_count);
  }
  for (const k of ["release_date", "released_time", "publish_time", "online_time"]) {
    if (r[k] != null) console.log(`${k}:`, r[k]);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
