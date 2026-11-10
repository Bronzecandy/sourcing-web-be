-- AlterTable
ALTER TABLE "TestAssignment" ADD COLUMN "answersUpdatedAt" TIMESTAMPTZ(6);

UPDATE "TestAssignment" SET "answersUpdatedAt" = "submittedAt" WHERE "answers" IS NOT NULL AND "submittedAt" IS NOT NULL;
