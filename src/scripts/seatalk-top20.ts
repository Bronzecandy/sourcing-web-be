/**
 * Daily Potential top-20 alert (14 ngày, combined).
 * Dry-run: npm run seatalk:top20 -- --dry
 */
import "../load-env";
import { prismaApp } from "../utils/prisma-app";
import { pool } from "../utils/prisma";
import { runPotentialTop20Alert } from "../services/potential-top20-alert.service";

async function main() {
  const dryRun = process.argv.includes("--dry") || process.argv.includes("--dry-run");
  const result = await runPotentialTop20Alert({ dryRun });

  console.log(
    JSON.stringify(
      {
        date: result.date,
        baseline: result.baseline,
        skipped: result.skipped,
        skipReason: result.skipReason,
        stale: result.stale,
        newCount: result.newCount,
        analyzedCount: result.analyzedCount,
        sent: result.sent,
        dryRun: result.dryRun,
        messageCount: result.messages.length,
        games: result.games.map((g) => ({
          appId: g.appId,
          title: g.title,
          boards: g.boards.map((b) => `${b.board}#${b.rank}`).join(", "),
          firstEver: g.firstEver,
          lastSeen: g.lastSeen,
          analysisId: g.analysisId,
        })),
      },
      null,
      2,
    ),
  );

  if (result.messages.length === 0) return;
  console.log("\n===== SeaTalk message =====\n");
  for (const [i, msg] of result.messages.entries()) {
    if (result.messages.length > 1) console.log(`--- part ${i + 1}/${result.messages.length} ---`);
    console.log(msg);
    console.log("");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaApp.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });
