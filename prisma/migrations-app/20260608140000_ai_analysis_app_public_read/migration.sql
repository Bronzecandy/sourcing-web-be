-- Index for public latest/history by appId (all users)
CREATE INDEX "UserAiAnalysis_appId_analyzedAt_idx" ON "UserAiAnalysis"("appId", "analyzedAt" DESC);
