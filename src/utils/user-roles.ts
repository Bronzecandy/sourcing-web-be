import type { UserRole } from "../types/auth";

export function isPanelAdmin(role: UserRole): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN";
}

export function isSuperAdmin(role: UserRole): boolean {
  return role === "SUPER_ADMIN";
}

export function canAssignRole(actor: UserRole, target: UserRole): boolean {
  if (actor === "SUPER_ADMIN") return true;
  if (actor === "ADMIN") {
    return target === "USER" || target === "STAFF" || target === "ADMIN";
  }
  return false;
}

/** No edits to any Super Admin account (including self). */
export function canManageUser(actor: UserRole, target: UserRole): boolean {
  if (target === "SUPER_ADMIN") return false;
  if (actor === "SUPER_ADMIN" || actor === "ADMIN") return true;
  return false;
}

/** Roles that store explicit permission rows (not implicit full access). */
export function roleUsesPermissionGrants(role: UserRole): boolean {
  return role !== "SUPER_ADMIN";
}
