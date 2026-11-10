-- DropForeignKey
ALTER TABLE "TestAssignment" DROP CONSTRAINT "TestAssignment_userId_fkey";

-- DropIndex
DROP INDEX "TestAssignment_campaignId_userId_key";

-- AlterTable
ALTER TABLE "TesterProfile" ADD COLUMN     "testerType" TEXT;

-- AlterTable
ALTER TABLE "TestCampaign" ADD COLUMN     "accessInfo" TEXT,
ADD COLUMN     "apkFolderError" TEXT,
ADD COLUMN     "apkFolderId" TEXT,
ADD COLUMN     "apkFolderUrl" TEXT,
ADD COLUMN     "background" TEXT,
ADD COLUMN     "conclusion" TEXT,
ADD COLUMN     "coordinatorEmail" TEXT,
ADD COLUMN     "coordinatorName" TEXT,
ADD COLUMN     "decision" TEXT,
ADD COLUMN     "devStage" TEXT,
ADD COLUMN     "developer" TEXT,
ADD COLUMN     "evalFormat" TEXT,
ADD COLUMN     "focusedAt" TIMESTAMPTZ(6),
ADD COLUMN     "focusedPlace" TEXT,
ADD COLUMN     "footageRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "googlePlayUrl" TEXT,
ADD COLUMN     "guide" TEXT,
ADD COLUMN     "hoursPerDay" DOUBLE PRECISION,
ADD COLUMN     "initiatedAt" TIMESTAMPTZ(6),
ADD COLUMN     "initiatedBy" TEXT,
ADD COLUMN     "installUrl" TEXT,
ADD COLUMN     "ipName" TEXT,
ADD COLUMN     "legacyReportUrl" TEXT,
ADD COLUMN     "noTest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "originalName" TEXT,
ADD COLUMN     "platforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "previousId" TEXT,
ADD COLUMN     "progressResearch" JSONB,
ADD COLUMN     "reportDeadline" DATE,
ADD COLUMN     "requester" TEXT,
ADD COLUMN     "seatalkError" TEXT,
ADD COLUMN     "seatalkStatus" TEXT,
ADD COLUMN     "securityLevel" TEXT NOT NULL DEFAULT 'normal',
ADD COLUMN     "source" TEXT,
ADD COLUMN     "sourceDetail" TEXT,
ADD COLUMN     "steamUrl" TEXT,
ADD COLUMN     "taptapUrl" TEXT,
ADD COLUMN     "templateId" TEXT,
ADD COLUMN     "templateSnapshot" JSONB,
ADD COLUMN     "testDays" INTEGER,
ADD COLUMN     "testRound" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "testerNote" TEXT,
ADD COLUMN     "updatedBy" TEXT,
ALTER COLUMN "status" SET DEFAULT 'pending';

-- AlterTable
ALTER TABLE "TestAssignment" ADD COLUMN     "aiReview" JSONB,
ADD COLUMN     "aiReviewAt" TIMESTAMPTZ(6),
ADD COLUMN     "aiStatus" TEXT,
ADD COLUMN     "answers" JSONB,
ADD COLUMN     "driveShare" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "invitedAt" TIMESTAMPTZ(6),
ADD COLUMN     "respondedAt" TIMESTAMPTZ(6),
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewStatus" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMPTZ(6),
ADD COLUMN     "reviewedBy" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'added',
ADD COLUMN     "submittedAt" TIMESTAMPTZ(6),
ADD COLUMN     "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "whitelistInfo" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- Data: dòng gán cũ định danh theo email của User
UPDATE "TestAssignment" a SET "email" = lower(u."email") FROM "User" u WHERE u."id" = a."userId";
DELETE FROM "TestAssignment" WHERE "email" IS NULL;
ALTER TABLE "TestAssignment" ALTER COLUMN "email" SET NOT NULL;

-- Data: tiến độ mới (planned → pending, running → testing)
UPDATE "TestCampaign" SET "status" = 'pending' WHERE "status" = 'planned';
UPDATE "TestCampaign" SET "status" = 'testing' WHERE "status" = 'running';
UPDATE "TestCampaign" SET "decision" = 'drop' WHERE "result" = 'unsuitable' AND "decision" IS NULL;
UPDATE "TestCampaign" SET "conclusion" = "resultNote" WHERE "conclusion" IS NULL AND "resultNote" IS NOT NULL;
UPDATE "TestCampaign" SET "platforms" = CASE "platform"
  WHEN 'MB' THEN ARRAY['Android','iOS']::TEXT[]
  WHEN 'PC' THEN ARRAY['PC']::TEXT[]
  WHEN 'CS' THEN ARRAY['Console']::TEXT[]
  ELSE ARRAY[]::TEXT[] END
WHERE "platform" IS NOT NULL;

-- Data: trạng thái tester cho dữ liệu cũ; đã hoàn thành = đã duyệt
UPDATE "TestAssignment" a SET
  "status" = CASE
    WHEN a."completed" THEN 'submitted'
    WHEN c."status" = 'testing' THEN 'in_test'
    WHEN c."status" = 'pending' THEN 'added'
    ELSE 'confirmed' END,
  "reviewStatus" = CASE WHEN a."completed" THEN 'approved' ELSE NULL END,
  "submittedAt" = CASE WHEN a."completed" THEN a."completedAt" ELSE NULL END
FROM "TestCampaign" c WHERE c."id" = a."campaignId";

-- CreateTable
CREATE TABLE "TestFile" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "dhash" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestMailTemplate" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestMailTemplate_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "TestMailLog" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "code" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "trigger" TEXT NOT NULL DEFAULT 'auto',
    "sentAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestMailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestTag" (
    "name" TEXT NOT NULL,
    "scored" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestTag_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "TestQuestionTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "genres" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isBase" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "questions" JSONB NOT NULL,
    "tagWeights" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TestQuestionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestReport" (
    "campaignId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'updating',
    "sections" JSONB NOT NULL DEFAULT '{}',
    "usp" TEXT,
    "pros" TEXT,
    "cons" TEXT,
    "conclusion" TEXT,
    "decision" TEXT,
    "configRequirement" JSONB,
    "configLevel" JSONB,
    "configUpdatedAt" TIMESTAMPTZ(6),
    "lockedAt" TIMESTAMPTZ(6),
    "lockedBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TestReport_pkey" PRIMARY KEY ("campaignId")
);

-- CreateTable
CREATE TABLE "TestReportRun" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "output" JSONB,
    "error" TEXT,
    "nSubmitted" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),
    "savedAt" TIMESTAMPTZ(6),
    "savedBy" TEXT,

    CONSTRAINT "TestReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestShareKey" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT,
    "expiresAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestShareKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestAuditLog" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "actor" TEXT,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestGameSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestGameSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "TestFile_campaignId_kind_idx" ON "TestFile"("campaignId", "kind");

-- CreateIndex
CREATE INDEX "TestFile_assignmentId_idx" ON "TestFile"("assignmentId");

-- CreateIndex
CREATE INDEX "TestFile_sha256_idx" ON "TestFile"("sha256");

-- CreateIndex
CREATE INDEX "TestFile_kind_dhash_idx" ON "TestFile"("kind", "dhash");

-- CreateIndex
CREATE INDEX "TestMailLog_campaignId_code_idx" ON "TestMailLog"("campaignId", "code");

-- CreateIndex
CREATE INDEX "TestMailLog_assignmentId_code_idx" ON "TestMailLog"("assignmentId", "code");

-- CreateIndex
CREATE INDEX "TestReportRun_campaignId_kind_createdAt_idx" ON "TestReportRun"("campaignId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TestShareKey_key_key" ON "TestShareKey"("key");

-- CreateIndex
CREATE INDEX "TestShareKey_campaignId_idx" ON "TestShareKey"("campaignId");

-- CreateIndex
CREATE INDEX "TestAuditLog_campaignId_createdAt_idx" ON "TestAuditLog"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "TestCampaign_gameName_idx" ON "TestCampaign"("gameName");

-- CreateIndex
CREATE INDEX "TestAssignment_email_idx" ON "TestAssignment"("email");

-- CreateIndex
CREATE INDEX "TestAssignment_reviewStatus_idx" ON "TestAssignment"("reviewStatus");

-- CreateIndex
CREATE UNIQUE INDEX "TestAssignment_campaignId_email_key" ON "TestAssignment"("campaignId", "email");

-- AddForeignKey
ALTER TABLE "TestAssignment" ADD CONSTRAINT "TestAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestFile" ADD CONSTRAINT "TestFile_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TestCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestFile" ADD CONSTRAINT "TestFile_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "TestAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMailLog" ADD CONSTRAINT "TestMailLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TestCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMailLog" ADD CONSTRAINT "TestMailLog_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "TestAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestReport" ADD CONSTRAINT "TestReport_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TestCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestReportRun" ADD CONSTRAINT "TestReportRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TestCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestShareKey" ADD CONSTRAINT "TestShareKey_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TestCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAuditLog" ADD CONSTRAINT "TestAuditLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TestCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
