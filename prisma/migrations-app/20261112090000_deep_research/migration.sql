-- CreateTable
CREATE TABLE "GameMarketMapping" (
    "appId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "stStatus" TEXT NOT NULL DEFAULT 'unmapped',
    "stUnifiedId" TEXT,
    "stName" TEXT,
    "stMethod" TEXT,
    "stRef" JSONB,
    "steamStatus" TEXT NOT NULL DEFAULT 'unmapped',
    "steamAppId" INTEGER,
    "steamName" TEXT,
    "steamMethod" TEXT,
    "steamRef" JSONB,
    "identity" JSONB,
    "identityAt" TIMESTAMPTZ(6),
    "checkedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GameMarketMapping_pkey" PRIMARY KEY ("appId")
);

-- CreateTable
CREATE TABLE "DeepResearchRun" (
    "id" TEXT NOT NULL,
    "appId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "iconUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "stages" JSONB,
    "context" JSONB,
    "createdById" TEXT,
    "createdByName" TEXT,
    "taptap" JSONB,
    "mapping" JSONB,
    "candidates" JSONB,
    "market" JSONB,
    "steam" JSONB,
    "web" JSONB,
    "summary" JSONB,
    "verdict" TEXT,
    "marketScore" DOUBLE PRECISION,
    "error" TEXT,
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DeepResearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GameMarketMapping_stUnifiedId_idx" ON "GameMarketMapping"("stUnifiedId");

-- CreateIndex
CREATE INDEX "GameMarketMapping_steamAppId_idx" ON "GameMarketMapping"("steamAppId");

-- CreateIndex
CREATE INDEX "DeepResearchRun_appId_createdAt_idx" ON "DeepResearchRun"("appId", "createdAt");

-- CreateIndex
CREATE INDEX "DeepResearchRun_createdAt_idx" ON "DeepResearchRun"("createdAt");
