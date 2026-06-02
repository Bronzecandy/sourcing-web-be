-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'STAFF');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'STAFF';

-- Migrate legacy isAdmin (if column exists from older deploy)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'isAdmin'
  ) THEN
    UPDATE "User" SET "role" = 'ADMIN' WHERE "isAdmin" = true AND "role" = 'STAFF';
    ALTER TABLE "User" DROP COLUMN "isAdmin";
  END IF;
END $$;
