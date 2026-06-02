export const PERMISSION_KEYS = [
  "crawl.dashboard",
  "crawl.ranking",
  "crawl.game",
  "crawl.reviews",
  "analytics.potential",
  "ai.read",
  "ai.run",
  "ai.delete",
  "libraries.read",
  "libraries.write",
  "translate.use",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export type UserStatus = "PENDING" | "ACTIVE";

export const USER_ROLES = ["SUPER_ADMIN", "ADMIN", "STAFF", "USER"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface PermissionMap {
  "crawl.dashboard": boolean;
  "crawl.ranking": boolean;
  "crawl.game": boolean;
  "crawl.reviews": boolean;
  "analytics.potential": boolean;
  "ai.read": boolean;
  "ai.run": boolean;
  "ai.delete": boolean;
  "libraries.read": boolean;
  "libraries.write": boolean;
  "translate.use": boolean;
}

export interface AuthUserDto {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  role: UserRole;
  /** True if user can open admin panel (Super Admin or Admin). */
  isPanelAdmin: boolean;
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
    "ai.read": false,
    "ai.run": false,
    "ai.delete": false,
    "libraries.read": false,
    "libraries.write": false,
    "translate.use": false,
  };
}

export function fullPermissions(): PermissionMap {
  const map = emptyPermissions();
  for (const k of PERMISSION_KEYS) map[k] = true;
  return map;
}
