export const PERMISSION_KEYS = [
  "crawl.dashboard",
  "crawl.ranking",
  "crawl.game",
  "crawl.reviews",
  "analytics.potential",
  "analytics.distribution",
  "ai.read",
  "ai.run",
  "ai.delete",
  "libraries.read",
  "libraries.write",
  "translate.use",
  "tester.manage",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export type UserStatus = "PENDING" | "ACTIVE";

/** TESTER: thành viên Tester Program; có thể đi kèm 1 role Sourcing (vd STAFF + TESTER). */
export const USER_ROLES = ["SUPER_ADMIN", "ADMIN", "STAFF", "USER", "TESTER"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Role cho web Sourcing — mỗi user tối đa 1. */
export const SOURCING_ROLES = ["SUPER_ADMIN", "ADMIN", "STAFF", "USER"] as const;
export type SourcingRole = (typeof SOURCING_ROLES)[number];

export interface PermissionMap {
  "crawl.dashboard": boolean;
  "crawl.ranking": boolean;
  "crawl.game": boolean;
  "crawl.reviews": boolean;
  "analytics.potential": boolean;
  "analytics.distribution": boolean;
  "ai.read": boolean;
  "ai.run": boolean;
  "ai.delete": boolean;
  "libraries.read": boolean;
  "libraries.write": boolean;
  "translate.use": boolean;
  "tester.manage": boolean;
}

export interface AuthUserDto {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  /** Role cao nhất trong `roles` (SUPER_ADMIN > ADMIN > STAFF > USER > TESTER). */
  role: UserRole;
  roles: UserRole[];
  /** True if user can open admin panel (Super Admin or Admin). */
  isPanelAdmin: boolean;
  isTester: boolean;
  permissions: PermissionMap;
}

export interface AdminUserDto extends AuthUserDto {
  createdAt: string;
}

export function emptyPermissions(): PermissionMap {
  return {
    "crawl.dashboard": false,
    "crawl.ranking": false,
    "crawl.game": false,
    "crawl.reviews": false,
    "analytics.potential": false,
    "analytics.distribution": false,
    "ai.read": false,
    "ai.run": false,
    "ai.delete": false,
    "libraries.read": false,
    "libraries.write": false,
    "translate.use": false,
    "tester.manage": false,
  };
}

export function fullPermissions(): PermissionMap {
  const map = emptyPermissions();
  for (const k of PERMISSION_KEYS) map[k] = true;
  return map;
}
