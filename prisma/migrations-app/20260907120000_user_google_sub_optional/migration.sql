-- Allow pre-provisioned users (email invite) before first Google login.
ALTER TABLE "User" ALTER COLUMN "googleSub" DROP NOT NULL;
