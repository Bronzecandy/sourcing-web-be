-- DISTINCT ON ("appId") ORDER BY "appId", "date" needs (appId, date), not (date, appId).
CREATE INDEX IF NOT EXISTS "apprank_appid_date_reserve_idx"
  ON "AppRank" ("appId", "date")
  WHERE "reserveAndroidRank" IS NOT NULL OR "reserveIosRank" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "apprank_appid_date_launched_idx"
  ON "AppRank" ("appId", "date")
  WHERE "hotAndroidRank" IS NOT NULL OR "hotIosRank" IS NOT NULL
     OR "popAndroidRank" IS NOT NULL OR "popIosRank" IS NOT NULL
     OR "newAndroidRank" IS NOT NULL OR "newIosRank" IS NOT NULL;
