import { OAuth2Client } from "google-auth-library";
import { SignJWT, jwtVerify } from "jose";
import type { Request, Response } from "express";
import { prismaApp } from "../utils/prisma-app";
import {
  PERMISSION_KEYS,
  type AuthUserDto,
  type PermissionKey,
  type PermissionMap,
  type UserRole,
  fullPermissions,
} from "../types/auth";
import { permissionsFromRows } from "../utils/permissions";
import { isPanelAdmin, isSuperAdmin } from "../utils/user-roles";
import type { UserRole as PrismaUserRole } from "../../generated/prisma-app/client";

const COOKIE_NAME = "sourcing_token";

function jwtSecret(): Uint8Array {
  const s = process.env.AUTH_JWT_SECRET?.trim();
  if (!s) throw new Error("AUTH_JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

function apiBaseUrl(): string {
  return (process.env.AUTH_API_BASE_URL || `http://localhost:${process.env.PORT || "3001"}`).replace(
    /\/$/,
    "",
  );
}

function frontendUrl(): string {
  return (process.env.AUTH_FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
}

export function getOAuthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required");
  }
  return new OAuth2Client(clientId, clientSecret, `${apiBaseUrl()}/api/auth/google/callback`);
}

export function getGoogleAuthUrl(): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    prompt: "select_account",
  });
}

export async function userToDto(
  user: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    status: "PENDING" | "ACTIVE";
    role: PrismaUserRole;
    permissions: Array<{ permissionKey: string; granted: boolean }>;
  },
): Promise<AuthUserDto> {
  const role = user.role as UserRole;
  const permissions: PermissionMap = isSuperAdmin(role)
    ? fullPermissions()
    : permissionsFromRows(user.permissions);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    status: user.status,
    role,
    isPanelAdmin: isPanelAdmin(role),
    permissions,
  };
}

async function ensurePermissionRows(userId: string): Promise<void> {
  for (const permissionKey of PERMISSION_KEYS) {
    await prismaApp.userPermission.upsert({
      where: { userId_permissionKey: { userId, permissionKey } },
      create: { userId, permissionKey, granted: false },
      update: {},
    });
  }
}

export async function grantAllPermissions(userId: string): Promise<void> {
  for (const permissionKey of PERMISSION_KEYS) {
    await prismaApp.userPermission.upsert({
      where: { userId_permissionKey: { userId, permissionKey } },
      create: { userId, permissionKey, granted: true },
      update: { granted: true },
    });
  }
}

export async function handleGoogleCallback(code: string): Promise<AuthUserDto> {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error("No id_token from Google");

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw new Error("Invalid Google token payload");

  const email = payload.email.toLowerCase();
  const bootstrapEmail = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const isBootstrap = bootstrapEmail && email === bootstrapEmail;

  let user = await prismaApp.user.findUnique({
    where: { googleSub: payload.sub },
    include: { permissions: true },
  });

  if (!user) {
    const byEmail = await prismaApp.user.findUnique({
      where: { email },
      include: { permissions: true },
    });
    if (byEmail) {
      user = await prismaApp.user.update({
        where: { id: byEmail.id },
        data: {
          googleSub: payload.sub,
          name: payload.name ?? byEmail.name,
          avatarUrl: payload.picture ?? byEmail.avatarUrl,
        },
        include: { permissions: true },
      });
    } else {
      user = await prismaApp.user.create({
        data: {
          googleSub: payload.sub,
          email,
          name: payload.name ?? null,
          avatarUrl: payload.picture ?? null,
          status: isBootstrap ? "ACTIVE" : "PENDING",
          role: isBootstrap ? "SUPER_ADMIN" : "USER",
        },
        include: { permissions: true },
      });
      await ensurePermissionRows(user.id);
      if (isBootstrap) await grantAllPermissions(user.id);
      user = await prismaApp.user.findUniqueOrThrow({
        where: { id: user.id },
        include: { permissions: true },
      });
    }
  } else {
    user = await prismaApp.user.update({
      where: { id: user.id },
      data: {
        name: payload.name ?? user.name,
        avatarUrl: payload.picture ?? user.avatarUrl,
        ...(isBootstrap ? { status: "ACTIVE" as const, role: "SUPER_ADMIN" as const } : {}),
      },
      include: { permissions: true },
    });
    if (isBootstrap) await grantAllPermissions(user.id);
  }

  if (user.permissions.length === 0) {
    await ensurePermissionRows(user.id);
    user = await prismaApp.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { permissions: true },
    });
  }

  return userToDto(user);
}

export async function createSessionToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(jwtSecret());
}

export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export function setAuthCookie(res: Response, token: string): void {
  const secure = process.env.AUTH_COOKIE_SECURE === "true";
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearAuthCookie(res: Response): void {
  const secure = process.env.AUTH_COOKIE_SECURE === "true";
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/",
  });
}

export function readAuthCookie(req: Request): string | undefined {
  return req.cookies?.[COOKIE_NAME];
}

export async function getUserById(userId: string): Promise<AuthUserDto | null> {
  const user = await prismaApp.user.findUnique({
    where: { id: userId },
    include: { permissions: true },
  });
  if (!user) return null;
  return userToDto(user);
}

const ROUTE_PERMISSION_FALLBACK: Array<{ perm: PermissionKey; path: string }> = [
  { perm: "crawl.dashboard", path: "/" },
  { perm: "crawl.ranking", path: "/ranking" },
  { perm: "analytics.potential", path: "/potential" },
  { perm: "ai.read", path: "/ai-analysis" },
  { perm: "libraries.read", path: "/libraries" },
];

export function redirectAfterLogin(user: AuthUserDto): string {
  const base = frontendUrl();
  if (user.status === "PENDING") return `${base}/waiting`;
  if (user.isPanelAdmin) {
    const first = ROUTE_PERMISSION_FALLBACK.find((r) => user.permissions[r.perm]);
    if (first) return `${base}${first.path === "/" ? "" : first.path}`;
    return `${base}/admin/users`;
  }
  const first = ROUTE_PERMISSION_FALLBACK.find((r) => user.permissions[r.perm]);
  if (!first) return `${base}/waiting`;
  if (first.path === "/") return `${base}/`;
  return `${base}${first.path}`;
}

export { COOKIE_NAME, frontendUrl };
