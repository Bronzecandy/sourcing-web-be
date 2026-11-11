-- CreateTable
CREATE TABLE "TestBotJob" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "campaignId" TEXT,
    "context" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "TestBotJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestBotJob_status_createdAt_idx" ON "TestBotJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TestBotJob_campaignId_action_status_idx" ON "TestBotJob"("campaignId", "action", "status");
