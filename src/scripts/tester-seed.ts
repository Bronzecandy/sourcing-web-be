/**
 * Seed Tester Program: bảng hỏi (data/tester/questionnaire.json) + Game Library (data/tester/game-library.json).
 *   npm run tester:seed            tạo khi chưa có / version tăng
 *   npm run tester:seed -- --force ghi đè bảng hỏi hiện tại
 */
import "../load-env";
import { prismaApp } from "../utils/prisma-app";
import { seedSurveyForm, validateQuestionnaire } from "../services/tester-survey.service";
import { ensureGameLibrarySeeded } from "../services/tester-scoring.service";
import { testerConfig } from "../services/tester-config";

async function main() {
  const report = validateQuestionnaire(testerConfig.questionnaire());
  console.log(
    `[tester-seed] questionnaire: ${report.errors.length} lỗi, ${report.warnings.length} cảnh báo, ${report.placeholders.length} placeholder`,
  );
  for (const line of [...report.errors, ...report.warnings, ...report.placeholders]) console.log(`  - ${line}`);
  const survey = await seedSurveyForm({ force: process.argv.includes("--force") });
  console.log(`[tester-seed] survey ${survey.seeded ? "seeded" : "unchanged"} v${survey.version}`);
  const library = await ensureGameLibrarySeeded();
  console.log(`[tester-seed] game library +${library}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaApp.$disconnect().catch(() => undefined);
  });
