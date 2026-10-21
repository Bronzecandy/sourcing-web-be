/**
 * Run today's Game Radar Recap once (research + Next Action + save).
 * Cron also runs this after the 10:15 precompute.
 */
import "../load-env";
import { prismaApp } from "../utils/prisma-app";
import { pool } from "../utils/prisma";
import { runRadarRecap } from "../services/radar-recap.service";

async function main() {
  const result = await runRadarRecap();
  console.log(JSON.stringify(result, null, 2));
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
