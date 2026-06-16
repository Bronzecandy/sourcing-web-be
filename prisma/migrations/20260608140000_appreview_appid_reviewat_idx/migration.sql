-- Composite index for AI stratified review sampling by app + time window.
CREATE INDEX IF NOT EXISTS "appreview_appid_reviewat_idx"
  ON "AppReview" ("appId", "reviewAt")
  WHERE raw IS NOT NULL;
