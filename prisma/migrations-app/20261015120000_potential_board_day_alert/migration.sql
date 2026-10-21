-- CreateTable
CREATE TABLE "PotentialBoardDay" (
    "date" DATE NOT NULL,
    "board" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "appId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PotentialBoardDay_pkey" PRIMARY KEY ("date","board","rank")
);

-- CreateIndex
CREATE INDEX "PotentialBoardDay_date_board_idx" ON "PotentialBoardDay"("date", "board");

-- CreateIndex
CREATE INDEX "PotentialBoardDay_board_appId_idx" ON "PotentialBoardDay"("board", "appId");

-- CreateTable
CREATE TABLE "PotentialAlertRun" (
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "newCount" INTEGER NOT NULL DEFAULT 0,
    "analyzedCount" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PotentialAlertRun_pkey" PRIMARY KEY ("date")
);
