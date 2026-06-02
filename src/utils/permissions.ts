import type { AuthUserDto, PermissionKey, PermissionMap } from "../types/auth";
import { PERMISSION_KEYS, emptyPermissions } from "../types/auth";
import { isSuperAdmin } from "./user-roles";

/** Permissions implied when a key is granted. */
const IMPLIED: Partial<Record<PermissionKey, PermissionKey[]>> = {
  "crawl.ranking": ["crawl.game"],
  "libraries.write": ["libraries.read"],
  "ai.run": ["ai.read"],
};

export function expandGrantedKeys(granted: Set<PermissionKey>): Set<PermissionKey> {
  const out = new Set(granted);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of out) {
      for (const implied of IMPLIED[key] ?? []) {
        if (!out.has(implied)) {
          out.add(implied);
          changed = true;
        }
      }
    }
  }
  return out;
}

export function permissionsFromRows(
  rows: Array<{ permissionKey: string; granted: boolean }>,
): PermissionMap {
  const map = emptyPermissions();
  const granted = new Set<PermissionKey>();
  for (const r of rows) {
    const k = r.permissionKey as PermissionKey;
    if (PERMISSION_KEYS.includes(k) && r.granted) granted.add(k);
  }
  for (const k of expandGrantedKeys(granted)) map[k] = true;
  return map;
}

export function hasPermission(user: AuthUserDto, key: PermissionKey): boolean {
  if (isSuperAdmin(user.role)) return true;
  return user.permissions[key] === true;
}

export function hasAnyPermission(user: AuthUserDto, keys: PermissionKey[]): boolean {
  return keys.some((k) => hasPermission(user, k));
}
