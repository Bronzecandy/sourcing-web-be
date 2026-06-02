-- Add USER to UserRole
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'USER';

-- Default role for new users
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'USER';

-- Create UserPermission from UserTabAccess data
CREATE TABLE "UserPermission" (
    "userId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "UserPermission_pkey" PRIMARY KEY ("userId","permissionKey")
);

ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate tab grants → domain permissions
INSERT INTO "UserPermission" ("userId", "permissionKey", "granted")
SELECT "userId", 'crawl.dashboard', "granted"
FROM "UserTabAccess" WHERE "tabKey" = 'dashboard';

INSERT INTO "UserPermission" ("userId", "permissionKey", "granted")
SELECT "userId", 'crawl.ranking', "granted"
FROM "UserTabAccess" WHERE "tabKey" = 'ranking';

INSERT INTO "UserPermission" ("userId", "permissionKey", "granted")
SELECT "userId", 'crawl.game', "granted"
FROM "UserTabAccess" WHERE "tabKey" = 'ranking';

INSERT INTO "UserPermission" ("userId", "permissionKey", "granted")
SELECT "userId", 'crawl.reviews', "granted"
FROM "UserTabAccess" WHERE "tabKey" = 'ranking';

INSERT INTO "UserPermission" ("userId", "permissionKey", "granted")
SELECT "userId", 'translate.use', "granted"
FROM "UserTabAccess" WHERE "tabKey" = 'dashboard';

INSERT INTO "UserPermission" ("userId", "permissionKey", "granted")
SELECT "userId", 'analytics.potential', "granted"
FROM "UserTabAccess" WHERE "tabKey" = 'potential';

INSERT INTO "UserPermission" ("userId", "permissionKey", "granted")
SELECT "userId", 'ai.read', "granted"
FROM "UserTabAccess" WHERE "tabKey" = 'ai_analysis';

INSERT INTO "UserPermission" ("userId", "permissionKey", "granted")
SELECT "userId", 'ai.run', "granted"
FROM "UserTabAccess" WHERE "tabKey" = 'ai_analysis';

INSERT INTO "UserPermission" ("userId", "permissionKey", "granted")
SELECT "userId", 'ai.delete', "granted"
FROM "UserTabAccess" WHERE "tabKey" = 'ai_analysis';

INSERT INTO "UserPermission" ("userId", "permissionKey", "granted")
SELECT "userId", 'libraries.read', "granted"
FROM "UserTabAccess" WHERE "tabKey" = 'libraries';

INSERT INTO "UserPermission" ("userId", "permissionKey", "granted")
SELECT "userId", 'libraries.write', "granted"
FROM "UserTabAccess" WHERE "tabKey" = 'libraries';

-- Ensure every user has rows for all permission keys (default false)
INSERT INTO "UserPermission" ("userId", "permissionKey", "granted")
SELECT u."id", k.key, false
FROM "User" u
CROSS JOIN (
  VALUES
    ('crawl.dashboard'),
    ('crawl.ranking'),
    ('crawl.game'),
    ('crawl.reviews'),
    ('analytics.potential'),
    ('ai.read'),
    ('ai.run'),
    ('ai.delete'),
    ('libraries.read'),
    ('libraries.write'),
    ('translate.use')
) AS k(key)
ON CONFLICT ("userId", "permissionKey") DO NOTHING;

DROP TABLE "UserTabAccess";
DROP TYPE "TabKey";
