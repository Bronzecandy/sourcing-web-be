-- Partial indexes for distribution cohort DISTINCT ON queries (reserve / launched boards).
CREATE INDEX IF NOT EXISTS "apprank_date_reserve_idx"
  ON "AppRank" ("date", "appId")
  WHERE "reserveAndroidRank" IS NOT NULL OR "reserveIosRank" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "apprank_date_launched_idx"
  ON "AppRank" ("date", "appId")
  WHERE "hotAndroidRank" IS NOT NULL OR "hotIosRank" IS NOT NULL
     OR "popAndroidRank" IS NOT NULL OR "popIosRank" IS NOT NULL
     OR "newAndroidRank" IS NOT NULL OR "newIosRank" IS NOT NULL;
