-- CreateTable
CREATE TABLE "RadarRecapRun" (
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "periodCode" TEXT NOT NULL,
    "summary" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RadarRecapRun_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "RadarRecapRow" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "board" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "appId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "titleEn" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "nextAction" TEXT NOT NULL,
    "insights" TEXT NOT NULL,
    "adjustments" TEXT NOT NULL,
    "screening" TEXT NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "RadarRecapRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RadarRecapRow_date_board_rank_key" ON "RadarRecapRow"("date", "board", "rank");

-- CreateIndex
CREATE INDEX "RadarRecapRow_date_board_idx" ON "RadarRecapRow"("date", "board");

-- CreateIndex
CREATE INDEX "RadarRecapRow_appId_date_idx" ON "RadarRecapRow"("appId", "date");

-- AddForeignKey
ALTER TABLE "RadarRecapRow" ADD CONSTRAINT "RadarRecapRow_date_fkey" FOREIGN KEY ("date") REFERENCES "RadarRecapRun"("date") ON DELETE CASCADE ON UPDATE CASCADE;
