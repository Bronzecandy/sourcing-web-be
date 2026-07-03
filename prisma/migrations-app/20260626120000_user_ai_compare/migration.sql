-- CreateTable
CREATE TABLE "UserAiCompare" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "appIdsKey" TEXT NOT NULL,
    "appIds" JSONB NOT NULL,
    "comparedAt" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAiCompare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAiCompare_appIdsKey_comparedAt_idx" ON "UserAiCompare"("appIdsKey", "comparedAt" DESC);

-- CreateIndex
CREATE INDEX "UserAiCompare_userId_idx" ON "UserAiCompare"("userId");

-- AddForeignKey
ALTER TABLE "UserAiCompare" ADD CONSTRAINT "UserAiCompare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
