import type { Prisma } from "../../../generated/prisma-app/client";
import { prismaApp } from "../../utils/prisma-app";
import { seatalkConfig } from "../seatalk/config";
import { DEFAULT_SETTINGS, type TestGameSettings } from "./defaults";

export class TestGameError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly issues: string[] = [],
  ) {
    super(message);
  }
}

const DAY_MS = 86_400_000;

/** Ngày hôm nay theo giờ Việt Nam (YYYY-MM-DD). */
export function todayIct(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(now);
}

export function hourIct(now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hourCycle: "h23" }).format(now));
}

export function isoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Ngày ICT của một thời điểm. */
export function ictDateOf(d: Date | null | undefined): string | null {
  return d ? todayIct(d) : null;
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00.000Z`) - Date.parse(`${fromIso}T00:00:00.000Z`)) / DAY_MS);
}

export function viDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function parseDateInput(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00.000Z`);
  throw new TestGameError("Ngày không hợp lệ (YYYY-MM-DD)");
}

export function publicUrl(): string {
  return seatalkConfig().publicUrl;
}

export function normalizeEmail(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase();
}

const EMAIL_RE = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$/i;

export function isEmail(v: string): boolean {
  return EMAIL_RE.test(v);
}

/** Tách danh sách email dán vào: dấu phẩy, chấm phẩy, khoảng trắng, xuống dòng; bỏ trùng, chữ thường. */
export function parseEmailList(raw: unknown): { valid: string[]; invalid: string[]; duplicates: string[] } {
  const parts = (Array.isArray(raw) ? raw.join("\n") : String(raw ?? ""))
    .split(/[\s,;]+/)
    .map((s) => s.replace(/^<|>$/g, "").trim().toLowerCase())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  for (const p of parts) {
    if (!isEmail(p)) invalid.push(p);
    else if (valid.includes(p)) duplicates.push(p);
    else valid.push(p);
  }
  return { valid, invalid: [...new Set(invalid)], duplicates: [...new Set(duplicates)] };
}

export async function audit(
  campaignId: string | null,
  actor: string | null | undefined,
  action: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await prismaApp.testAuditLog.create({
      data: { campaignId, actor: actor ?? "system", action, detail: (detail ?? undefined) as Prisma.InputJsonValue | undefined },
    });
  } catch (err) {
    console.warn("[testgame] audit failed:", (err as Error).message);
  }
}

let settingsCache: { at: number; value: TestGameSettings } | null = null;

export async function getSettings(): Promise<TestGameSettings> {
  if (settingsCache && Date.now() - settingsCache.at < 30_000) return settingsCache.value;
  const row = await prismaApp.testGameSetting.findUnique({ where: { key: "general" } });
  const stored = (row?.value ?? {}) as Partial<TestGameSettings>;
  const value: TestGameSettings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    configLibrary: Array.isArray(stored.configLibrary) && stored.configLibrary.length > 0 ? stored.configLibrary : DEFAULT_SETTINGS.configLibrary,
  };
  if (!value.seatalkGroupId) value.seatalkGroupId = process.env.SEATALK_TESTGAME_GROUP_ID?.trim() ?? "";
  if (!value.driveRootFolderId) value.driveRootFolderId = process.env.TESTGAME_DRIVE_ROOT_FOLDER_ID?.trim() ?? "";
  settingsCache = { at: Date.now(), value };
  return value;
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export async function saveSettings(body: Record<string, unknown>, actor: string): Promise<TestGameSettings> {
  const cur = await getSettings();
  const text = (v: unknown, fallback: string) => (typeof v === "string" ? v.trim() : fallback);
  const library = Array.isArray(body.configLibrary)
    ? (body.configLibrary as Array<Record<string, unknown>>)
        .map((r) => ({ level: text(r.level, ""), android: text(r.android, ""), ios: text(r.ios, ""), pc: text(r.pc, "") }))
        .filter((r) => r.level)
    : cur.configLibrary;
  const next: TestGameSettings = {
    sendHour: num(body.sendHour, 0, 23, cur.sendHour),
    remindAfterDays: num(body.remindAfterDays, 1, 14, cur.remindAfterDays),
    responseDays: num(body.responseDays, 1, 30, cur.responseDays),
    remindBeforeDays: num(body.remindBeforeDays, 1, 14, cur.remindBeforeDays),
    senderName: text(body.senderName, cur.senderName) || DEFAULT_SETTINGS.senderName,
    senderEmail: text(body.senderEmail, cur.senderEmail) || DEFAULT_SETTINGS.senderEmail,
    seatalkGroupId: text(body.seatalkGroupId, cur.seatalkGroupId),
    driveRootFolderId: text(body.driveRootFolderId, cur.driveRootFolderId),
    evidenceMax: num(body.evidenceMax, 1, 5, cur.evidenceMax),
    footageMaxMb: num(body.footageMaxMb, 10, 1024, cur.footageMaxMb),
    configLibrary: library.length > 0 ? library : cur.configLibrary,
  };
  await prismaApp.testGameSetting.upsert({
    where: { key: "general" },
    create: { key: "general", value: next as unknown as Prisma.InputJsonValue, updatedBy: actor },
    update: { value: next as unknown as Prisma.InputJsonValue, updatedBy: actor },
  });
  settingsCache = null;
  await audit(null, actor, "settings.update", { keys: Object.keys(body) });
  return getSettings();
}
