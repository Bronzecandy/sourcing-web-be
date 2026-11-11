import fs from "fs";
import path from "path";
import type { Prisma } from "../../../generated/prisma-app/client";
import { prismaApp } from "../../utils/prisma-app";
import { canSendAsBot, seatalkConfig } from "../seatalk/config";
import { sendGroupMessage } from "../seatalk/client";
import { defaultWorkload } from "../tester-admin.service";
import { genreLabel } from "../tester-config";
import { audit, getSettings, isoDate, parseDateInput, publicUrl, TestGameError, todayIct, viDate } from "./common";
import { DECISIONS, EVAL_FORMATS, labelOf, MAIL_CODES, PLATFORMS, SECURITY_LEVELS, SOURCES } from "./defaults";
import { fileDto, uploadRoot } from "./files";
import { folderJobPending, queueDriveFolder } from "./bot-jobs";
import { driveAvailable } from "./google-bot";
import { nextMail, sendCampaignMail } from "./mail";
import { startConfigRun } from "./report";
import { startDueCampaigns } from "./scheduler";
import { buildSnapshot, campaignTemplate, pickTemplateId } from "./templates";

export type CampaignRow = Awaited<ReturnType<typeof prismaApp.testCampaign.findUniqueOrThrow>>;

const PLATFORM_TO_DEVICE: Record<string, string> = { Android: "MB", iOS: "MB", PC: "PC", Console: "CS" };

export function devicesOf(platforms: string[]): string[] {
  return [...new Set(platforms.map((p) => PLATFORM_TO_DEVICE[p]).filter(Boolean))];
}

function str(v: unknown, max = 2000): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function url(v: unknown): string | null {
  const s = str(v, 1000);
  if (!s) return null;
  if (!/^https?:\/\/\S+$/i.test(s)) throw new TestGameError(`Link không hợp lệ: ${s.slice(0, 60)}`);
  return s;
}

function parseAppId(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/\/app\/(\d+)/) ?? s.match(/^(\d+)$/);
  if (!m) throw new TestGameError("TapTap ID không hợp lệ");
  const n = Number(m[1]);
  if (n > 2_147_483_647) throw new TestGameError("TapTap ID quá lớn");
  return n;
}

function list(v: unknown, allowed?: readonly string[]): string[] {
  const arr = Array.isArray(v) ? v : String(v ?? "").split(/[,;|\n]/);
  const out = [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
  return allowed ? out.filter((x) => allowed.includes(x)) : out;
}

function positive(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new TestGameError("Số không hợp lệ");
  return n;
}

const TEXT_FIELDS = [
  "originalName",
  "genre",
  "developer",
  "ipName",
  "devStage",
  "background",
  "requester",
  "sourceDetail",
  "focusedPlace",
  "guide",
  "testerNote",
  "accessInfo",
  "coordinatorName",
  "team",
  "conclusion",
  "legacyReportUrl",
] as const;
const URL_FIELDS = ["taptapUrl", "googlePlayUrl", "steamUrl", "installUrl", "iconUrl"] as const;
const DATE_FIELDS = ["startDate", "endDate", "reportDeadline"] as const;

/** Chuẩn hoá body form game test → data Prisma (chỉ các trường được gửi). */
function campaignInput(body: Record<string, unknown>): Prisma.TestCampaignUncheckedUpdateInput {
  const data: Prisma.TestCampaignUncheckedUpdateInput = {};
  if (body.gameName !== undefined) {
    const name = str(body.gameName, 200);
    if (!name) throw new TestGameError("Cần tên game");
    data.gameName = name;
  }
  for (const k of TEXT_FIELDS) if (body[k] !== undefined) data[k] = str(body[k], k === "background" || k === "guide" ? 10_000 : 2000);
  for (const k of URL_FIELDS) if (body[k] !== undefined) data[k] = url(body[k]);
  for (const k of DATE_FIELDS) if (body[k] !== undefined) data[k] = parseDateInput(body[k]);
  if (body.appId !== undefined) data.appId = parseAppId(body.appId);
  if (body.platforms !== undefined) {
    const platforms = list(body.platforms, PLATFORMS);
    data.platforms = platforms;
    data.platform = devicesOf(platforms)[0] ?? null;
  }
  if (body.mainTags !== undefined) data.mainTags = list(body.mainTags);
  if (body.secondaryTags !== undefined) data.secondaryTags = list(body.secondaryTags);
  if (body.source !== undefined) {
    const s = str(body.source);
    if (s && !SOURCES.some((x) => x.key === s)) throw new TestGameError("Nguồn không hợp lệ");
    data.source = s;
  }
  if (body.securityLevel !== undefined) {
    const s = String(body.securityLevel);
    if (!SECURITY_LEVELS.some((x) => x.key === s)) throw new TestGameError("Mức bảo mật không hợp lệ");
    data.securityLevel = s;
  }
  if (body.evalFormat !== undefined) {
    const s = str(body.evalFormat);
    if (s && !EVAL_FORMATS.some((x) => x.key === s)) throw new TestGameError("Hình thức đánh giá không hợp lệ");
    data.evalFormat = s;
  }
  if (body.hoursPerDay !== undefined) data.hoursPerDay = positive(body.hoursPerDay);
  if (body.testDays !== undefined) {
    const n = positive(body.testDays);
    data.testDays = n == null ? null : Math.round(n);
  }
  if (body.focusedAt !== undefined) {
    const s = str(body.focusedAt);
    const d = s ? new Date(s) : null;
    if (d && Number.isNaN(d.getTime())) throw new TestGameError("Thời gian test tập trung không hợp lệ");
    data.focusedAt = d;
  }
  if (body.workloadHours !== undefined && body.workloadHours !== "" && body.workloadHours !== null) {
    data.workloadHours = positive(body.workloadHours) ?? 0;
  }
  if (body.coordinatorEmail !== undefined) data.coordinatorEmail = str(body.coordinatorEmail)?.toLowerCase() ?? null;
  if (body.noTest !== undefined) data.noTest = body.noTest === true;
  if (body.footageRequired !== undefined) data.footageRequired = body.footageRequired === true;
  if (body.templateId !== undefined) data.templateId = str(body.templateId);
  return data;
}

/** Trường bắt buộc trước khi Initiate (mục 3.2 bước 2). */
export function initiateIssues(c: CampaignRow, testerCount: number): string[] {
  const issues: string[] = [];
  const need = (ok: unknown, label: string) => {
    if (!ok || (Array.isArray(ok) && ok.length === 0)) issues.push(label);
  };
  need(c.gameName, "Tên game");
  need(c.genre, "Thể loại");
  need(c.mainTags, "Dòng game chính");
  need(c.platforms, "Platform");
  need(c.source, "Nguồn");
  need(c.securityLevel, "Mức bảo mật");
  need(c.evalFormat, "Hình thức đánh giá");
  if (c.evalFormat === "daily") need(c.hoursPerDay && c.testDays, "Số giờ/ngày và số ngày");
  if (c.evalFormat === "focused") need(c.focusedAt && c.focusedPlace, "Giờ và phòng / link test tập trung");
  need(c.guide, "Hướng dẫn tải / cài đặt");
  need(c.startDate, "Ngày bắt đầu test");
  need(c.endDate, "Hạn test");
  need(c.reportDeadline, "Hạn nộp report");
  need(c.coordinatorName && c.coordinatorEmail, "Người phụ trách (tên + email)");
  need(c.templateId, "Template questionnaire");
  const start = isoDate(c.startDate);
  const end = isoDate(c.endDate);
  const report = isoDate(c.reportDeadline);
  if (start && end && end < start) issues.push("Hạn test phải sau ngày bắt đầu");
  if (end && report && report < end) issues.push("Hạn nộp report phải sau hạn test");
  if (end && end < todayIct()) issues.push("Hạn test đã qua");
  if (testerCount === 0) issues.push("Ít nhất một tester");
  return issues;
}

function folderName(c: Pick<CampaignRow, "gameName" | "startDate">): string {
  const d = c.startDate ?? new Date();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `[Confidential] ${mm}.${d.getUTCFullYear()} | ${c.gameName}`;
}

/** Giao bot tạo folder APK trên Drive gốc (kết quả áp ở bot-jobs); lỗi chỉ ghi lại để Admin bấm "Tạo lại folder". */
async function ensureDriveFolder(c: CampaignRow, actor: string): Promise<void> {
  if (c.noTest || c.apkFolderId) return;
  const settings = await getSettings();
  let error: string | null = null;
  if (!driveAvailable()) error = "Chưa cấu hình bot Drive (TESTGAME_BOT_RELAY_URL)";
  else if (!settings.driveRootFolderId) error = "Chưa cấu hình thư mục Drive gốc";
  else if (await folderJobPending(c.id)) return;
  else {
    try {
      await queueDriveFolder(c.id, settings.driveRootFolderId, folderName(c), actor);
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
  }
  await prismaApp.testCampaign.update({ where: { id: c.id }, data: { apkFolderError: error } });
}

export async function retryDriveFolder(id: string, actor: string) {
  const c = await prismaApp.testCampaign.findUnique({ where: { id } });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  await prismaApp.testCampaign.update({ where: { id }, data: { apkFolderId: null, apkFolderUrl: null } });
  await ensureDriveFolder({ ...c, apkFolderId: null, apkFolderUrl: null }, actor);
  return campaignDetail(id);
}

async function nextRound(appId: number | null, gameName: string, excludeId?: string): Promise<number> {
  const agg = await prismaApp.testCampaign.aggregate({
    _max: { testRound: true },
    where: {
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [...(appId ? [{ appId }] : []), { gameName: { equals: gameName, mode: "insensitive" as const } }],
    },
  });
  return (agg._max.testRound ?? 0) + 1;
}

const COPY_FIELDS = [
  "gameName",
  "originalName",
  "appId",
  "iconUrl",
  "genre",
  "platform",
  "platforms",
  "mainTags",
  "secondaryTags",
  "developer",
  "ipName",
  "devStage",
  "taptapUrl",
  "googlePlayUrl",
  "steamUrl",
  "background",
  "source",
  "requester",
  "sourceDetail",
  "securityLevel",
  "evalFormat",
  "hoursPerDay",
  "testDays",
  "guide",
  "installUrl",
  "footageRequired",
  "workloadHours",
  "coordinatorName",
  "coordinatorEmail",
  "team",
] as const;

export async function createCampaign(body: Record<string, unknown>, actor: string) {
  let base: Record<string, unknown> = {};
  let previousId: string | null = null;
  if (typeof body.fromId === "string" && body.fromId) {
    const prev = await prismaApp.testCampaign.findUnique({ where: { id: body.fromId } });
    if (!prev) throw new TestGameError("Không tìm thấy game test cũ", 404);
    base = Object.fromEntries(COPY_FIELDS.map((k) => [k, prev[k]]));
    previousId = prev.id;
  }
  const data = { ...base, ...(campaignInput(body) as Record<string, unknown>) } as Prisma.TestCampaignUncheckedCreateInput;
  if (!data.gameName) throw new TestGameError("Cần tên game");
  const mainTags = (data.mainTags as string[] | undefined) ?? [];
  if (data.workloadHours === undefined) {
    data.workloadHours =
      data.evalFormat === "daily" && data.hoursPerDay && data.testDays ? Number(data.hoursPerDay) * Number(data.testDays) : defaultWorkload(mainTags[0]);
  }
  if (!data.noTest && !data.templateId) data.templateId = await pickTemplateId(mainTags);
  if (!data.coordinatorEmail) data.coordinatorEmail = actor;
  const created = await prismaApp.testCampaign.create({
    data: {
      ...data,
      previousId,
      testRound: await nextRound((data.appId as number | null) ?? null, String(data.gameName)),
      status: "pending",
      createdBy: actor,
      updatedBy: actor,
    },
  });
  if (!created.noTest) {
    await prismaApp.testReport.create({ data: { campaignId: created.id } });
    await ensureDriveFolder(created, actor);
    await startConfigRun(created.id, actor).catch((err) => console.warn("[testgame] config run:", (err as Error).message));
  }
  await audit(created.id, actor, "campaign.create", { gameName: created.gameName, testRound: created.testRound, fromId: previousId });
  return campaignDetail(created.id);
}

export async function updateCampaign(id: string, body: Record<string, unknown>, actor: string) {
  const cur = await prismaApp.testCampaign.findUnique({ where: { id } });
  if (!cur) throw new TestGameError("Không tìm thấy game test", 404);
  const data = campaignInput(body);
  if (cur.templateSnapshot && data.templateId !== undefined && data.templateId !== cur.templateId) {
    throw new TestGameError("Game test đã Initiate — template đã chốt, không đổi được");
  }
  if (cur.status !== "pending" && data.noTest !== undefined && data.noTest !== cur.noTest) {
    throw new TestGameError("Chỉ đổi Không test khi game test còn Pending");
  }
  const changed = Object.keys(data).filter((k) => JSON.stringify((cur as Record<string, unknown>)[k] ?? null) !== JSON.stringify((data as Record<string, unknown>)[k] ?? null));
  if (changed.length === 0) return campaignDetail(id);
  const updated = await prismaApp.testCampaign.update({ where: { id }, data: { ...data, updatedBy: actor } });
  if (!updated.noTest) {
    await prismaApp.testReport.upsert({ where: { campaignId: id }, create: { campaignId: id }, update: {} });
    if (!updated.apkFolderId && !updated.apkFolderError) await ensureDriveFolder(updated, actor);
  }
  await audit(id, actor, "campaign.update", {
    fields: changed.map((k) => (k === "accessInfo" ? "accessInfo (ẩn)" : k)),
    ...(changed.some((k) => DATE_FIELDS.includes(k as never))
      ? { dates: { startDate: isoDate(updated.startDate), endDate: isoDate(updated.endDate), reportDeadline: isoDate(updated.reportDeadline) } }
      : {}),
  });
  return campaignDetail(id);
}

export async function deleteCampaign(id: string, actor: string) {
  const c = await prismaApp.testCampaign.findUnique({ where: { id }, select: { gameName: true, status: true } });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  if (!["pending", "cancelled", "done"].includes(c.status)) throw new TestGameError("Huỷ game test trước khi xoá");
  await prismaApp.testCampaign.delete({ where: { id } });
  fs.rm(path.join(uploadRoot(), id), { recursive: true, force: true }, () => undefined);
  await audit(null, actor, "campaign.delete", { campaignId: id, gameName: c.gameName });
  return { deleted: true };
}

export async function cancelCampaign(id: string, actor: string) {
  const c = await prismaApp.testCampaign.findUnique({ where: { id } });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  if (c.status === "done" || c.status === "cancelled") throw new TestGameError("Game test đã kết thúc");
  await prismaApp.testCampaign.update({ where: { id }, data: { status: "cancelled", updatedBy: actor } });
  await audit(id, actor, "campaign.status", { from: c.status, to: "cancelled" });
  return campaignDetail(id);
}

/** Mở lại game test đã huỷ: quay về Pending nếu chưa Initiate, ngược lại về Inviting. */
export async function reopenCampaign(id: string, actor: string) {
  const c = await prismaApp.testCampaign.findUnique({ where: { id } });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  if (c.status !== "cancelled") throw new TestGameError("Chỉ mở lại game test đã huỷ");
  const to = c.initiatedAt ? "inviting" : "pending";
  await prismaApp.testCampaign.update({ where: { id }, data: { status: to, updatedBy: actor } });
  await audit(id, actor, "campaign.status", { from: "cancelled", to });
  return campaignDetail(id);
}

async function notifySeaTalk(c: CampaignRow, invited: number): Promise<{ status: string; error: string | null }> {
  const cfg = seatalkConfig();
  const settings = await getSettings();
  if (!cfg.enabled) return { status: "skipped", error: "SEATALK_ENABLED đang tắt" };
  if (!settings.seatalkGroupId || !canSendAsBot(cfg)) return { status: "skipped", error: "Chưa cấu hình nhóm SeaTalk vận hành" };
  const lines = [
    `🎮 Initiate game test: ${c.gameName}${c.testRound > 1 ? ` (lần ${c.testRound})` : ""}`,
    `Dòng game: ${c.mainTags.map(genreLabel).join(", ") || "-"}${c.genre ? ` · ${c.genre}` : ""}`,
    `Platform: ${c.platforms.join(", ") || "-"}`,
    `Thời gian: ${viDate(isoDate(c.startDate))} – ${viDate(isoDate(c.endDate))}`,
    `Tester được mời: ${invited}`,
    `Người phụ trách: ${c.coordinatorName ?? "-"}${c.coordinatorEmail ? ` (${c.coordinatorEmail})` : ""}`,
    `${publicUrl()}/admin/test-campaigns/${c.id}`,
  ];
  try {
    await sendGroupMessage(settings.seatalkGroupId, lines.join("\n"));
    return { status: "sent", error: null };
  } catch (err) {
    return { status: "failed", error: (err as Error).message.slice(0, 300) };
  }
}

/** Gửi M1 nền cho các dòng gán (không chặn request). */
export function sendInvitesInBackground(c: CampaignRow, assignmentIds: string[], actor: string, force = false): void {
  void (async () => {
    for (const id of assignmentIds) {
      const a = await prismaApp.testAssignment.findUnique({ where: { id } });
      if (!a) continue;
      try {
        await sendCampaignMail("M1", c, a, { trigger: force ? "manual" : "auto", force, actor });
      } catch (err) {
        console.error("[testgame] M1", a.email, (err as Error).message);
      }
    }
  })();
}

export async function initiateCampaign(id: string, actor: string) {
  const c = await prismaApp.testCampaign.findUnique({ where: { id }, include: { assignments: true } });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  if (c.noTest) throw new TestGameError("Game Không test không Initiate");
  if (c.status !== "pending" || c.initiatedAt) throw new TestGameError("Game test đã khởi động");
  const added = c.assignments.filter((a) => a.status === "added");
  const issues = initiateIssues(c, added.length);
  if (issues.length > 0) throw new TestGameError("Chưa đủ thông tin để Initiate", 400, issues);
  const snapshot = await buildSnapshot(c.templateId!);
  const now = new Date();
  const updated = await prismaApp.testCampaign.update({
    where: { id },
    data: { status: "inviting", initiatedAt: now, initiatedBy: actor, templateSnapshot: snapshot as unknown as Prisma.InputJsonValue, updatedBy: actor },
  });
  await prismaApp.testAssignment.updateMany({ where: { id: { in: added.map((a) => a.id) } }, data: { status: "invited", invitedAt: now } });
  await prismaApp.testReport.upsert({ where: { campaignId: id }, create: { campaignId: id }, update: {} });
  await startDueCampaigns({ id });
  sendInvitesInBackground(updated, added.map((a) => a.id), actor);
  const seatalk = await notifySeaTalk(updated, added.length);
  await prismaApp.testCampaign.update({ where: { id }, data: { seatalkStatus: seatalk.status, seatalkError: seatalk.error } });
  await audit(id, actor, "campaign.initiate", { testers: added.length, template: `${snapshot.name} v${snapshot.version}`, seatalk: seatalk.status });
  return campaignDetail(id);
}

export async function resendSeaTalk(id: string, actor: string) {
  const c = await prismaApp.testCampaign.findUnique({ where: { id }, include: { assignments: { select: { status: true } } } });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  if (!c.initiatedAt) throw new TestGameError("Game test chưa Initiate");
  const invited = c.assignments.filter((a) => a.status !== "added").length;
  const seatalk = await notifySeaTalk(c, invited);
  await prismaApp.testCampaign.update({ where: { id }, data: { seatalkStatus: seatalk.status, seatalkError: seatalk.error } });
  await audit(id, actor, "seatalk.resend", { status: seatalk.status });
  return campaignDetail(id);
}

/** Game "Không test": điền Quyết định rồi chuyển Done (không qua Inviting / Testing / Reporting). */
export async function finishNoTest(id: string, body: { decision?: unknown; conclusion?: unknown }, actor: string) {
  const c = await prismaApp.testCampaign.findUnique({ where: { id } });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  if (!c.noTest) throw new TestGameError("Chỉ dùng cho game Không test");
  const decision = body.decision ? String(body.decision) : null;
  if (decision && !DECISIONS.some((d) => d.key === decision)) throw new TestGameError("Quyết định không hợp lệ");
  await prismaApp.testCampaign.update({
    where: { id },
    data: {
      status: "done",
      decision,
      result: decision === "drop" ? "unsuitable" : decision === "recommend" ? "suitable" : null,
      conclusion: body.conclusion !== undefined ? str(body.conclusion, 5000) : c.conclusion,
      updatedBy: actor,
    },
  });
  await audit(id, actor, "campaign.status", { from: c.status, to: "done", decision });
  return campaignDetail(id);
}

const TESTER_ACTIVE = new Set(["invited", "confirmed", "in_test"]);

export function campaignSummary(
  c: CampaignRow & {
    assignments: Array<{ status: string; reviewStatus: string | null; completed: boolean; invitedAt: Date | null }>;
    mailLogs: Array<{ code: string; status: string; trigger: string }>;
    report: { status: string } | null;
  },
  settings: Awaited<ReturnType<typeof getSettings>>,
) {
  const a = c.assignments;
  const sentCodes = new Set(c.mailLogs.filter((m) => (m.status === "sent" || m.status === "queued") && m.trigger !== "test").map((m) => m.code));
  const mails = Object.fromEntries(
    MAIL_CODES.map((code) => {
      const logs = c.mailLogs.filter((m) => m.code === code && m.trigger !== "test");
      return [code, { sent: logs.filter((m) => m.status === "sent").length, failed: logs.filter((m) => m.status === "failed").length }];
    }),
  );
  const invitedDates = a.map((x) => x.invitedAt).filter((d): d is Date => Boolean(d));
  const firstInvited = invitedDates.length ? new Date(Math.min(...invitedDates.map((d) => d.getTime()))) : null;
  const report = isoDate(c.reportDeadline);
  return {
    id: c.id,
    gameName: c.gameName,
    originalName: c.originalName,
    testRound: c.testRound,
    iconUrl: c.iconUrl,
    appId: c.appId,
    genre: c.genre,
    mainTags: c.mainTags,
    secondaryTags: c.secondaryTags,
    platforms: c.platforms,
    securityLevel: c.securityLevel,
    noTest: c.noTest,
    status: c.status,
    decision: c.decision,
    startDate: isoDate(c.startDate),
    endDate: isoDate(c.endDate),
    reportDeadline: report,
    overdue: Boolean(report && report < todayIct() && c.status !== "done" && c.status !== "cancelled" && !c.noTest),
    coordinatorName: c.coordinatorName,
    workloadHours: c.workloadHours,
    counts: {
      total: a.length,
      invited: a.filter((x) => x.status !== "added").length,
      active: a.filter((x) => TESTER_ACTIVE.has(x.status)).length,
      confirmed: a.filter((x) => ["confirmed", "in_test", "submitted"].includes(x.status)).length,
      submitted: a.filter((x) => x.status === "submitted").length,
      approved: a.filter((x) => x.completed).length,
      pendingReview: a.filter((x) => x.status === "submitted" && x.reviewStatus === "pending").length,
    },
    mails,
    nextMail: nextMail(c, sentCodes, settings, invitedDates.length > 0, firstInvited),
    reportStatus: c.noTest ? null : c.report?.status ?? null,
    legacyReportUrl: c.legacyReportUrl,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listCampaigns(query: { q?: unknown; status?: unknown; genre?: unknown }) {
  const q = str(query.q);
  const status = str(query.status);
  const genre = str(query.genre);
  const rows = await prismaApp.testCampaign.findMany({
    where: {
      ...(status === "overdue" ? {} : status ? { status } : {}),
      ...(genre ? { mainTags: { has: genre } } : {}),
      ...(q
        ? {
            OR: [
              { gameName: { contains: q, mode: "insensitive" } },
              { originalName: { contains: q, mode: "insensitive" } },
              { genre: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: {
      assignments: { select: { status: true, reviewStatus: true, completed: true, invitedAt: true } },
      mailLogs: { select: { code: true, status: true, trigger: true } },
      report: { select: { status: true } },
    },
    orderBy: [{ createdAt: "desc" }],
  });
  const settings = await getSettings();
  const out = rows.map((c) => campaignSummary(c, settings));
  return status === "overdue" ? out.filter((c) => c.overdue) : out;
}

export async function campaignDetail(id: string) {
  const c = await prismaApp.testCampaign.findUnique({
    where: { id },
    include: {
      assignments: {
        include: {
          user: { select: { id: true, name: true, avatarUrl: true, testerProfile: { select: { name: true, testerType: true, platforms: true } } } },
          files: { orderBy: { createdAt: "asc" } },
          mailLogs: { orderBy: { sentAt: "asc" } },
        },
        orderBy: { createdAt: "asc" },
      },
      mailLogs: { select: { code: true, status: true, trigger: true } },
      report: { select: { status: true } },
      files: { where: { kind: "guide" }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  const settings = await getSettings();
  const template = await campaignTemplate(c);
  const templateRow = c.templateId ? await prismaApp.testQuestionTemplate.findUnique({ where: { id: c.templateId }, select: { name: true, version: true } }) : null;
  const added = c.assignments.filter((a) => a.status === "added").length;
  const busy = await busyMap(c.id, c.assignments.map((a) => a.email), c.startDate, c.endDate);
  return {
    ...campaignSummary(c, settings),
    previousId: c.previousId,
    developer: c.developer,
    ipName: c.ipName,
    devStage: c.devStage,
    taptapUrl: c.taptapUrl,
    googlePlayUrl: c.googlePlayUrl,
    steamUrl: c.steamUrl,
    background: c.background,
    source: c.source,
    sourceLabel: labelOf(SOURCES, c.source),
    requester: c.requester,
    sourceDetail: c.sourceDetail,
    templateId: c.templateId,
    template: template
      ? {
          name: template.name,
          version: template.version,
          locked: Boolean(c.templateSnapshot),
          questionCount: template.questions.length,
          questions: template.questions,
          tags: template.tags.map((t) => t.name),
          latestVersion: templateRow?.version ?? null,
        }
      : null,
    evalFormat: c.evalFormat,
    hoursPerDay: c.hoursPerDay,
    testDays: c.testDays,
    focusedAt: c.focusedAt?.toISOString() ?? null,
    focusedPlace: c.focusedPlace,
    guide: c.guide,
    installUrl: c.installUrl,
    testerNote: c.testerNote,
    accessInfo: c.accessInfo,
    footageRequired: c.footageRequired,
    apkFolderUrl: c.apkFolderUrl,
    apkFolderError: c.apkFolderError,
    apkFolderPending: !c.noTest && !c.apkFolderId ? await folderJobPending(c.id) : false,
    coordinatorEmail: c.coordinatorEmail,
    team: c.team,
    conclusion: c.conclusion,
    initiatedAt: c.initiatedAt?.toISOString() ?? null,
    initiatedBy: c.initiatedBy,
    seatalkStatus: c.seatalkStatus,
    seatalkError: c.seatalkError,
    createdBy: c.createdBy,
    updatedBy: c.updatedBy,
    updatedAt: c.updatedAt.toISOString(),
    guideFiles: c.files.map(fileDto),
    initiateIssues: c.status === "pending" && !c.noTest ? initiateIssues(c, added) : [],
    assignments: c.assignments.map((a) => ({
      id: a.id,
      email: a.email,
      userId: a.userId,
      name: a.user?.testerProfile?.name ?? a.user?.name ?? null,
      avatarUrl: a.user?.avatarUrl ?? null,
      testerType: a.user?.testerProfile?.testerType ?? null,
      devices: a.user?.testerProfile?.platforms ?? [],
      status: a.status,
      invitedAt: a.invitedAt?.toISOString() ?? null,
      respondedAt: a.respondedAt?.toISOString() ?? null,
      submittedAt: a.submittedAt?.toISOString() ?? null,
      workloadHours: a.workloadHours ?? c.workloadHours,
      customHours: a.workloadHours != null,
      completed: a.completed,
      completedAt: a.completedAt?.toISOString() ?? null,
      reviewStatus: a.reviewStatus,
      reviewNote: a.reviewNote,
      reviewedBy: a.reviewedBy,
      reviewedAt: a.reviewedAt?.toISOString() ?? null,
      aiStatus: a.aiStatus,
      aiReview: a.aiReview,
      aiReviewAt: a.aiReviewAt?.toISOString() ?? null,
      whitelistInfo: a.whitelistInfo,
      driveShare: a.driveShare,
      note: a.note,
      answers: a.status === "submitted" || a.status === "in_test" ? a.answers : null,
      busyWith: busy.get(a.email) ?? [],
      evidence: a.files.filter((f) => f.kind === "evidence").map(fileDto),
      footage: a.files.filter((f) => f.kind === "footage").map(fileDto),
      mails: a.mailLogs.map((m) => ({ code: m.code, status: m.status, error: m.error, sentAt: m.sentAt.toISOString(), trigger: m.trigger })),
    })),
  };
}

/** Tester đang được mời / test game khác trùng ngày (cảnh báo, không chặn). */
export async function busyMap(campaignId: string, emails: string[], start: Date | null, end: Date | null): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (emails.length === 0 || !start || !end) return out;
  const rows = await prismaApp.testAssignment.findMany({
    where: {
      email: { in: emails },
      campaignId: { not: campaignId },
      status: { in: ["invited", "confirmed", "in_test"] },
      campaign: { status: { in: ["pending", "inviting", "testing"] }, startDate: { lte: end }, endDate: { gte: start } },
    },
    select: { email: true, campaign: { select: { gameName: true, startDate: true, endDate: true } } },
  });
  for (const r of rows) {
    const label = `${r.campaign.gameName} (${viDate(isoDate(r.campaign.startDate))}–${viDate(isoDate(r.campaign.endDate))})`;
    out.set(r.email, [...(out.get(r.email) ?? []), label]);
  }
  return out;
}

export async function campaignAudit(id: string) {
  const rows = await prismaApp.testAuditLog.findMany({ where: { campaignId: id }, orderBy: { createdAt: "desc" }, take: 300 });
  const mails = await prismaApp.testMailLog.findMany({ where: { campaignId: id }, orderBy: { sentAt: "desc" }, take: 500 });
  return {
    actions: rows.map((r) => ({ id: r.id, actor: r.actor, action: r.action, detail: r.detail, createdAt: r.createdAt.toISOString() })),
    mails: mails.map((m) => ({
      id: m.id,
      code: m.code,
      toEmail: m.toEmail,
      subject: m.subject,
      status: m.status,
      error: m.error,
      attempts: m.attempts,
      trigger: m.trigger,
      sentAt: m.sentAt.toISOString(),
    })),
  };
}

/** Danh sách game test đã có để chọn "Test lại game cũ". */
export async function previousCampaignOptions(q: string) {
  const rows = await prismaApp.testCampaign.findMany({
    where: q ? { OR: [{ gameName: { contains: q, mode: "insensitive" } }, { originalName: { contains: q, mode: "insensitive" } }] } : {},
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, gameName: true, originalName: true, testRound: true, iconUrl: true, status: true, startDate: true },
  });
  return rows.map((r) => ({ ...r, startDate: isoDate(r.startDate) }));
}
