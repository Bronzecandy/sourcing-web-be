import { Router } from "express";
import { prismaApp } from "../utils/prisma-app";
import type { AuthedRequest } from "../middleware/auth";
import { requireAuth, requirePanelAdmin } from "../middleware/auth";
import { userToDto } from "../services/auth.service";
import { PERMISSION_KEYS, USER_ROLES, type PermissionKey, type UserRole } from "../types/auth";
import { canAssignRole, canManageUser, isSuperAdmin, roleUsesPermissionGrants } from "../utils/user-roles";
import type { UserRole as PrismaUserRole } from "../../generated/prisma-app/client";

const router = Router();

router.use(requireAuth, requirePanelAdmin);

router.get("/users", async (_req, res) => {
  try {
    const users = await prismaApp.user.findMany({
      orderBy: { createdAt: "desc" },
      include: { permissions: true },
    });
    const data = await Promise.all(
      users.map(async (u) => ({
        ...(await userToDto(u)),
        createdAt: u.createdAt.toISOString(),
      })),
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error("[admin] list users:", err);
    res.status(500).json({ success: false, error: "Failed to list users" });
  }
});

router.patch("/users/:id", async (req: AuthedRequest, res) => {
  try {
    const actor = req.authUser!;
    const id = String(req.params.id ?? "");
    const body = req.body as {
      status?: "PENDING" | "ACTIVE";
      role?: UserRole;
      permissions?: Partial<Record<PermissionKey, boolean>>;
    };

    const existing = await prismaApp.user.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, error: "User not found" });
      return;
    }

    const targetRole = existing.role as UserRole;

    if (targetRole === "SUPER_ADMIN") {
      res.status(403).json({
        success: false,
        error: "Super Admin accounts cannot be modified",
        code: "SUPER_ADMIN_PROTECTED",
      });
      return;
    }

    if (!canManageUser(actor.role, targetRole)) {
      res.status(403).json({ success: false, error: "Cannot manage this user", code: "FORBIDDEN" });
      return;
    }

    if (body.role !== undefined) {
      if (!USER_ROLES.includes(body.role)) {
        res.status(400).json({ success: false, error: "Invalid role" });
        return;
      }
      if (!canAssignRole(actor.role, body.role)) {
        res.status(403).json({
          success: false,
          error: "Only Super Admin can assign Super Admin role",
          code: "ROLE_FORBIDDEN",
        });
        return;
      }
      await prismaApp.user.update({
        where: { id },
        data: { role: body.role as PrismaUserRole },
      });
    }

    if (body.status) {
      await prismaApp.user.update({ where: { id }, data: { status: body.status } });
    }

    const effectiveRole =
      body.role !== undefined ? body.role : (existing.role as UserRole);

    if (
      body.permissions &&
      typeof body.permissions === "object" &&
      roleUsesPermissionGrants(effectiveRole)
    ) {
      for (const permissionKey of PERMISSION_KEYS) {
        if (typeof body.permissions[permissionKey] === "boolean") {
          await prismaApp.userPermission.upsert({
            where: { userId_permissionKey: { userId: id, permissionKey } },
            create: {
              userId: id,
              permissionKey,
              granted: body.permissions[permissionKey]!,
            },
            update: { granted: body.permissions[permissionKey]! },
          });
        }
      }
    }

    const updated = await prismaApp.user.findUniqueOrThrow({
      where: { id },
      include: { permissions: true },
    });
    res.json({
      success: true,
      data: { ...(await userToDto(updated)), createdAt: updated.createdAt.toISOString() },
    });
  } catch (err) {
    console.error("[admin] patch user:", err);
    res.status(500).json({ success: false, error: "Failed to update user" });
  }
});

router.get("/meta", (req: AuthedRequest, res) => {
  const actor = req.authUser!;
  res.json({
    success: true,
    data: {
      actorRole: actor.role,
      canAssignSuperAdmin: isSuperAdmin(actor.role),
      assignableRoles: USER_ROLES.filter((r) => canAssignRole(actor.role, r)),
    },
  });
});

export default router;
