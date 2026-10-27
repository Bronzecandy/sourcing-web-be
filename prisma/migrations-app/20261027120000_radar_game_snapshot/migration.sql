-- CreateTable
CREATE TABLE "RadarGameSnapshot" (
    "date" DATE NOT NULL,
    "appId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "reserveCount" INTEGER,
    "downloadCount" INTEGER,
    "rating" TEXT,
    "flag" INTEGER,
    "releaseDate" TEXT,
    "scheduleKind" TEXT,
    "scheduleDate" TEXT,
    "scheduleLabel" TEXT,
    "facts" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RadarGameSnapshot_pkey" PRIMARY KEY ("date","appId")
);

-- CreateIndex
CREATE INDEX "RadarGameSnapshot_appId_date_idx" ON "RadarGameSnapshot"("appId", "date");
