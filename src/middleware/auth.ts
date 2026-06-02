import type { Request, Response, NextFunction } from "express";
import { verifySessionToken, readAuthCookie, getUserById } from "../services/auth.service";
import type { AuthUserDto, PermissionKey } from "../types/auth";
import { hasPermission } from "../utils/permissions";

export type AuthedRequest = Request & { authUser?: AuthUserDto };

export async function attachAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const token = readAuthCookie(req);
  if (!token) {
    next();
    return;
  }
  const userId = await verifySessionToken(token);
  if (!userId) {
    next();
    return;
  }
  const user = await getUserById(userId);
  if (user) req.authUser = user;
  next();
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ success: false, error: "Unauthorized", code: "UNAUTHORIZED" });
    return;
  }
  next();
}

export function requireActive(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ success: false, error: "Unauthorized", code: "UNAUTHORIZED" });
    return;
  }
  if (req.authUser.status !== "ACTIVE") {
    res.status(403).json({ success: false, error: "Account pending approval", code: "PENDING" });
    return;
  }
  next();
}

export function requirePanelAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser?.isPanelAdmin) {
    res.status(403).json({ success: false, error: "Admin access required", code: "FORBIDDEN" });
    return;
  }
  next();
}

/** @deprecated use requirePanelAdmin */
export const requireAdmin = requirePanelAdmin;

export function requirePermission(permission: PermissionKey) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ success: false, error: "Unauthorized", code: "UNAUTHORIZED" });
      return;
    }
    if (req.authUser.status !== "ACTIVE") {
      res.status(403).json({ success: false, error: "Account pending approval", code: "PENDING" });
      return;
    }
    if (hasPermission(req.authUser, permission)) {
      next();
      return;
    }
    res.status(403).json({
      success: false,
      error: "Permission denied",
      code: "PERMISSION_FORBIDDEN",
      permission,
    });
  };
}

export type ApiPermissionGuard = PermissionKey | "admin" | null;

export function resolvePermissionForApiPath(path: string, method: string): ApiPermissionGuard {
  const m = method.toUpperCase();
  if (path.startsWith("/admin")) return "admin";

  if (path.startsWith("/games/dashboard")) return "crawl.dashboard";
  if (
    path.startsWith("/games/rankings") ||
    path.startsWith("/games/dates") ||
    path.startsWith("/games/tags") ||
    path.startsWith("/games/compare")
  ) {
    return "crawl.ranking";
  }
  if (/^\/games\/\d+\/reviews/.test(path)) return "crawl.reviews";
  if (/^\/games\/\d+/.test(path)) return "crawl.game";

  if (path.startsWith("/ranking")) return "analytics.potential";

  if (path.startsWith("/analysis")) {
    if (m === "DELETE") return "ai.delete";
    if (m === "POST") return "ai.run";
    return "ai.read";
  }

  if (path.startsWith("/libraries")) {
    if (m === "GET") return "libraries.read";
    return "libraries.write";
  }

  if (path.startsWith("/translate")) return "translate.use";

  return null;
}

export function apiPermissionGuard(req: AuthedRequest, res: Response, next: NextFunction): void {
  const permission = resolvePermissionForApiPath(req.path, req.method);
  if (permission === null) {
    next();
    return;
  }
  if (permission === "admin") {
    requirePanelAdmin(req, res, next);
    return;
  }
  requirePermission(permission)(req, res, next);
}

/** @deprecated */
export const apiTabGuard = apiPermissionGuard;
