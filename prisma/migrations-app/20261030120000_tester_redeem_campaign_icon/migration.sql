-- Tester tự đổi quà: trạng thái yêu cầu + thông tin nhận quà (bản ghi cũ coi như đã trao)
ALTER TABLE "BenefitRedemption" ADD COLUMN     "adminNote" TEXT,
ADD COLUMN     "game" TEXT,
ADD COLUMN     "gameAccount" TEXT,
ADD COLUMN     "processedAt" TIMESTAMPTZ(6),
ADD COLUMN     "processedBy" TEXT,
ADD COLUMN     "reward" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'fulfilled',
ADD COLUMN     "tier" INTEGER;

CREATE INDEX "BenefitRedemption_status_createdAt_idx" ON "BenefitRedemption"("status", "createdAt");

-- Icon TapTap của game trong đợt test
ALTER TABLE "TestCampaign" ADD COLUMN     "iconUrl" TEXT;
