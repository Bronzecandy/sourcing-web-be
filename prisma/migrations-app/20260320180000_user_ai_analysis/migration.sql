-- CreateTable
CREATE TABLE "UserAiAnalysis" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "appId" INTEGER NOT NULL,
    "analyzedAt" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAiAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAiAnalysis_userId_appId_analyzedAt_key" ON "UserAiAnalysis"("userId", "appId", "analyzedAt");

-- CreateIndex
CREATE INDEX "UserAiAnalysis_userId_idx" ON "UserAiAnalysis"("userId");

-- CreateIndex
CREATE INDEX "UserAiAnalysis_userId_appId_idx" ON "UserAiAnalysis"("userId", "appId");

-- AddForeignKey
ALTER TABLE "UserAiAnalysis" ADD CONSTRAINT "UserAiAnalysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
