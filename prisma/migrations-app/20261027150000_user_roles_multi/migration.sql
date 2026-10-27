-- Mỗi user có nhiều role: User.role (1 giá trị) -> User.roles (mảng)
ALTER TABLE "User" ADD COLUMN "roles" "UserRole"[] NOT NULL DEFAULT ARRAY['USER']::"UserRole"[];

UPDATE "User" SET "roles" = ARRAY["role"]::"UserRole"[];

-- Ai đã có hồ sơ tester thì có thêm role TESTER (vd Staff vừa làm tester)
UPDATE "User" u
SET "roles" = array_append(u."roles", 'TESTER'::"UserRole")
WHERE EXISTS (SELECT 1 FROM "TesterProfile" p WHERE p."userId" = u."id")
  AND NOT ('TESTER'::"UserRole" = ANY (u."roles"));

ALTER TABLE "User" DROP COLUMN "role";
