-- CreateTable
CREATE TABLE "SurveyForm" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "introduction" TEXT NOT NULL,
    "supplement" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SurveyForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyQuestion" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "mustAnswer" BOOLEAN NOT NULL DEFAULT true,
    "page" INTEGER NOT NULL DEFAULT 1,
    "pic" TEXT,
    "video" TEXT,
    "regex" TEXT,
    "semanticKey" TEXT,
    "genreKey" TEXT,

    CONSTRAINT "SurveyQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyOption" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "jump" INTEGER,
    "connect" INTEGER[],
    "fix" BOOLEAN NOT NULL DEFAULT true,
    "exclusive" BOOLEAN NOT NULL DEFAULT false,
    "textInput" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SurveyOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyResponse" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "formVersion" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "startedAt" TIMESTAMPTZ(6),
    "submittedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationSec" INTEGER,
    "device" TEXT,
    "source" TEXT NOT NULL DEFAULT 'web',

    CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TesterProfile" (
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "office" TEXT,
    "team" TEXT,
    "ageRange" TEXT,
    "platforms" TEXT[],
    "gender" TEXT,
    "weeklyPlayLabel" TEXT,
    "weeklyPlayLevel" INTEGER,
    "payLabel" TEXT,
    "payTier" TEXT,
    "testTimeLabel" TEXT,
    "favoriteGenre" TEXT,
    "genres" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "scoringStatus" TEXT NOT NULL DEFAULT 'pending',
    "scoredAt" TIMESTAMPTZ(6),
    "responseId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TesterProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "TesterGenreScore" (
    "userId" TEXT NOT NULL,
    "genre" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "rawHash" TEXT NOT NULL,
    "volumeScore" INTEGER NOT NULL,
    "rankScore" INTEGER NOT NULL,
    "hasRank" BOOLEAN NOT NULL,
    "hours" INTEGER NOT NULL,
    "matches" INTEGER NOT NULL,
    "anchorGame" TEXT,
    "bestRank" TEXT,
    "matchedGames" JSONB NOT NULL,
    "finalScore" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "model" TEXT,
    "scoredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TesterGenreScore_pkey" PRIMARY KEY ("userId","genre")
);

-- CreateTable
CREATE TABLE "GameLibraryEntry" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "aliases" TEXT[],
    "genres" TEXT[],
    "subgenres" TEXT[],
    "source" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "notes" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GameLibraryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TesterScoreCache" (
    "key" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TesterScoreCache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "TestCampaign" (
    "id" TEXT NOT NULL,
    "gameName" TEXT NOT NULL,
    "appId" INTEGER,
    "genre" TEXT,
    "platform" TEXT,
    "mainTags" TEXT[],
    "secondaryTags" TEXT[],
    "workloadHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startDate" DATE,
    "endDate" DATE,
    "team" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "result" TEXT,
    "resultNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TestCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestAssignment" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workloadHours" DOUBLE PRECISION,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMPTZ(6),
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenefitRedemption" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "item" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BenefitRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SurveyForm_slug_key" ON "SurveyForm"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "SurveyQuestion_formId_number_key" ON "SurveyQuestion"("formId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SurveyOption_questionId_order_key" ON "SurveyOption"("questionId", "order");

-- CreateIndex
CREATE INDEX "SurveyResponse_userId_submittedAt_idx" ON "SurveyResponse"("userId", "submittedAt" DESC);

-- CreateIndex
CREATE INDEX "TesterGenreScore_genre_finalScore_idx" ON "TesterGenreScore"("genre", "finalScore");

-- CreateIndex
CREATE UNIQUE INDEX "GameLibraryEntry_canonicalName_key" ON "GameLibraryEntry"("canonicalName");

-- CreateIndex
CREATE INDEX "TestCampaign_appId_idx" ON "TestCampaign"("appId");

-- CreateIndex
CREATE INDEX "TestCampaign_status_startDate_idx" ON "TestCampaign"("status", "startDate");

-- CreateIndex
CREATE INDEX "TestAssignment_userId_idx" ON "TestAssignment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TestAssignment_campaignId_userId_key" ON "TestAssignment"("campaignId", "userId");

-- CreateIndex
CREATE INDEX "BenefitRedemption_userId_idx" ON "BenefitRedemption"("userId");

-- AddForeignKey
ALTER TABLE "SurveyQuestion" ADD CONSTRAINT "SurveyQuestion_formId_fkey" FOREIGN KEY ("formId") REFERENCES "SurveyForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyOption" ADD CONSTRAINT "SurveyOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "SurveyQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_formId_fkey" FOREIGN KEY ("formId") REFERENCES "SurveyForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterProfile" ADD CONSTRAINT "TesterProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterGenreScore" ADD CONSTRAINT "TesterGenreScore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "TesterProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAssignment" ADD CONSTRAINT "TestAssignment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TestCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAssignment" ADD CONSTRAINT "TestAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitRedemption" ADD CONSTRAINT "BenefitRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
