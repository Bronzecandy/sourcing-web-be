/**
 * One-off: import `.ai-analysis-store.json` into UserAiAnalysis for bootstrap admin.
 * Run: npx tsx src/scripts/import-legacy-ai-store.ts
 */
import "../load-env";
import fs from "fs";
import path from "path";
import { prismaApp } from "../utils/prisma-app";
import type { AIAnalysisResult } from "../types";
import { saveAnalysisForUser } from "../services/ai-analysis-store";

const STORE_FILE = path.join(process.cwd(), ".ai-analysis-store.json");

async function main() {
  const bootstrapEmail = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  if (!bootstrapEmail) {
    console.error("Set ADMIN_BOOTSTRAP_EMAIL to assign imported analyses.");
    process.exit(1);
  }
  const user = await prismaApp.user.findUnique({ where: { email: bootstrapEmail } });
  if (!user) {
    console.error(`No user for ${bootstrapEmail}`);
    process.exit(1);
  }
  if (!fs.existsSync(STORE_FILE)) {
    console.log("[import-legacy-ai] No .ai-analysis-store.json — skip.");
    return;
  }
  const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8")) as Record<string, AIAnalysisResult[]>;
  let imported = 0;
  let skipped = 0;
  for (const list of Object.values(store)) {
    for (const item of list) {
      const exists = await prismaApp.userAiAnalysis.findUnique({
        where: {
          userId_appId_analyzedAt: {
            userId: user.id,
            appId: item.appId,
            analyzedAt: new Date(item.analyzedAt),
          },
        },
      });
      if (exists) {
        skipped++;
        continue;
      }
      await saveAnalysisForUser(user.id, item);
      imported++;
    }
  }
  console.log(`[import-legacy-ai] imported=${imported} skipped=${skipped} for ${bootstrapEmail}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prismaApp.$disconnect());
