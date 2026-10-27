import { SOURCING_ROLES, USER_ROLES, type SourcingRole, type UserRole } from "../types/auth";

const ROLE_ORDER: readonly UserRole[] = ["SUPER_ADMIN", "ADMIN", "STAFF", "USER", "TESTER"];

export function isPanelAdmin(role: UserRole): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN";
}

export function isSuperAdmin(role: UserRole): boolean {
  return role === "SUPER_ADMIN";
}

/** Role chính (cao nhất) — dùng cho kiểm tra quyền Sourcing. */
export function primaryRole(roles: readonly UserRole[]): UserRole {
  return ROLE_ORDER.find((r) => roles.includes(r)) ?? "USER";
}

export function sourcingRole(roles: readonly UserRole[]): SourcingRole | null {
  for (const r of SOURCING_ROLES) if (roles.includes(r)) return r;
  return null;
}

/**
 * Chuẩn hóa danh sách role: bỏ giá trị lạ/trùng, giữ tối đa 1 role Sourcing (cao nhất), có thể kèm TESTER.
 * Trả null nếu input không phải mảng role hợp lệ.
 */
export function normalizeRoles(input: unknown): UserRole[] | null {
  if (!Array.isArray(input)) return null;
  const valid = input.filter((r): r is UserRole => (USER_ROLES as readonly string[]).includes(String(r)));
  if (valid.length !== input.length) return null;
  const out: UserRole[] = [];
  const sourcing = sourcingRole(valid);
  if (sourcing) out.push(sourcing);
  if (valid.includes("TESTER")) out.push("TESTER");
  return out.length > 0 ? out : ["USER"];
}

export function canAssignRole(actor: UserRole, target: UserRole): boolean {
  if (actor === "SUPER_ADMIN") return true;
  if (actor === "ADMIN") {
    return target === "USER" || target === "STAFF" || target === "ADMIN" || target === "TESTER";
  }
  return false;
}

export function canAssignRoles(actor: UserRole, roles: readonly UserRole[]): boolean {
  return roles.every((r) => canAssignRole(actor, r));
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
