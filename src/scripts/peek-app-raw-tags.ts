/**
 * Gợi ý tag / developer từ DB (AppRank.raw, TapTap snapshot).
 * Dùng cùng extractor với pipeline phân tích (extractTags / extractDeveloperPublisher).
 *
 * Chạy: npm run peek:tags
 * DATABASE_URL đọc từ .env (vd. social_taptap_db).
 */
import "../load-env";
import { prisma } from "../utils/prisma";
import { extractDeveloperPublisher, extractTags } from "../services/analysis-context";

async function main() {
  const detailRows = await prisma.appRank.findMany({
    take: 10,
    orderBy: { date: "desc" },
    select: { appId: true, date: true, raw: true },
  });

  console.log("=== Mẫu chi tiết (10 bản ghi mới nhất) ===\n");
  for (const r of detailRows) {
    const raw = r.raw as Record<string, unknown> | null;
    const title = typeof raw?.title === "string" ? raw.title : "?";
    const tags = extractTags(raw ?? undefined);
    const { developerName, publisherName, developerResolvedViaPublisherFallback } = extractDeveloperPublisher(raw ?? undefined);
    console.log("---");
    console.log("appId:", r.appId, "date:", r.date.toISOString().slice(0, 10));
    console.log("title:", title);
    console.log("tags:", tags.length ? tags.join(" | ") : "(none)");
    console.log("developer:", developerName ?? "(empty)", developerResolvedViaPublisherFallback ? " [dev=publisher fallback]" : "");
    console.log("publisher:", publisherName ?? "(empty)");
  }

  const sample = await prisma.appRank.findMany({
    take: 400,
    orderBy: { date: "desc" },
    select: { raw: true },
  });

  const tagCount = new Map<string, number>();
  for (const r of sample) {
    const raw = r.raw as Record<string, unknown> | null | undefined;
    for (const t of extractTags(raw ?? undefined)) {
      const k = t.trim();
      if (!k) continue;
      tagCount.set(k, (tagCount.get(k) ?? 0) + 1);
    }
  }

  const top = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
  console.log("\n=== Top tag (từ", sample.length, "bản ghi raw gần nhất) ===\n");
  for (const [tag, n] of top) {
    console.log(String(n).padStart(4), tag);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
