import fs from "fs";
import { prismaApp } from "../../utils/prisma-app";
import { addDays, audit, daysBetween, getSettings, ictDateOf, isoDate, publicUrl, TestGameError, todayIct, viDate } from "./common";
import { DEFAULT_MAIL_TEMPLATES, EVAL_FORMATS, labelOf, MAIL_CODES, type TestGameSettings } from "./defaults";
import { absolutePath } from "./files";
import { sendMail, type MailAttachment } from "./google-bot";

type Campaign = Awaited<ReturnType<typeof prismaApp.testCampaign.findUniqueOrThrow>>;
type Assignment = Awaited<ReturnType<typeof prismaApp.testAssignment.findUniqueOrThrow>>;

let seeded = false;

export async function ensureMailTemplates(): Promise<void> {
  if (seeded) return;
  await prismaApp.testMailTemplate.createMany({
    data: DEFAULT_MAIL_TEMPLATES.map((t) => ({ code: t.code, name: t.name, subject: t.subject, body: t.body, updatedBy: "system" })),
    skipDuplicates: true,
  });
  seeded = true;
}

type MailTemplateRow = Awaited<ReturnType<typeof prismaApp.testMailTemplate.findUniqueOrThrow>>;

function mailTemplateDto(r: MailTemplateRow) {
  return { ...r, updatedAt: r.updatedAt.toISOString(), defaultSubject: DEFAULT_MAIL_TEMPLATES.find((d) => d.code === r.code)?.subject };
}

export async function listMailTemplates() {
  await ensureMailTemplates();
  const rows = await prismaApp.testMailTemplate.findMany();
  return MAIL_CODES.map((code) => rows.find((r) => r.code === code)!)
    .filter(Boolean)
    .map(mailTemplateDto);
}

export async function saveMailTemplate(code: string, body: { subject?: unknown; body?: unknown; enabled?: unknown; reset?: unknown }, actor: string) {
  await ensureMailTemplates();
  const cur = await prismaApp.testMailTemplate.findUnique({ where: { code } });
  if (!cur) throw new TestGameError("Không có mẫu mail này", 404);
  const def = DEFAULT_MAIL_TEMPLATES.find((d) => d.code === code)!;
  const subject = body.reset === true ? def.subject : typeof body.subject === "string" ? body.subject.trim() : cur.subject;
  const text = body.reset === true ? def.body : typeof body.body === "string" ? body.body : cur.body;
  if (!subject || !text.trim()) throw new TestGameError("Tiêu đề và nội dung không được trống");
  const changed = subject !== cur.subject || text !== cur.body;
  const saved = await prismaApp.testMailTemplate.update({
    where: { code },
    data: {
      subject,
      body: text,
      enabled: typeof body.enabled === "boolean" ? body.enabled : cur.enabled,
      ...(changed ? { version: cur.version + 1 } : {}),
      updatedBy: actor,
    },
  });
  await audit(null, actor, "mail_template.update", { code, version: saved.version, enabled: saved.enabled });
  return mailTemplateDto(saved);
}

function testFormat(c: Campaign): string {
  const base = labelOf(EVAL_FORMATS, c.evalFormat);
  if (c.evalFormat === "daily" && c.hoursPerDay && c.testDays) return `Chơi ${c.hoursPerDay} giờ/ngày trong ${c.testDays} ngày`;
  if (c.evalFormat === "focused") {
    const at = c.focusedAt
      ? new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }).format(c.focusedAt)
      : "";
    return [base, at && `lúc ${at}`, c.focusedPlace && `tại ${c.focusedPlace}`].filter(Boolean).join(" ");
  }
  return base;
}

/** Hạn phản hồi = ngày mời + số ngày cấu hình; trước ngày bắt đầu nếu được mời trước đợt test. */
export function responseDeadline(c: Pick<Campaign, "startDate" | "endDate">, invitedAt: Date | null, settings: TestGameSettings): string {
  const invited = ictDateOf(invitedAt) ?? todayIct();
  let deadline = addDays(invited, settings.responseDays);
  const start = isoDate(c.startDate);
  const end = isoDate(c.endDate);
  if (start && invited < start) deadline = deadline < addDays(start, -1) ? deadline : addDays(start, -1);
  else if (end && deadline > end) deadline = end;
  return deadline < invited ? invited : deadline;
}

export async function testerName(a: Pick<Assignment, "userId" | "email">): Promise<string | null> {
  const user = a.userId
    ? await prismaApp.user.findUnique({ where: { id: a.userId }, select: { name: true, testerProfile: { select: { name: true } } } })
    : await prismaApp.user.findUnique({ where: { email: a.email }, select: { name: true, testerProfile: { select: { name: true } } } });
  return user?.testerProfile?.name ?? user?.name ?? null;
}

export function testerLinks(assignmentId: string) {
  return {
    response: `${publicUrl()}/tester/tests/${assignmentId}`,
    survey: `${publicUrl()}/tester/tests/${assignmentId}/survey`,
  };
}

async function mailParams(c: Campaign, a: Assignment | null, settings: TestGameSettings, guideFiles: string[]): Promise<Record<string, string>> {
  const end = isoDate(c.endDate);
  const links = a ? testerLinks(a.id) : { response: `${publicUrl()}/tester/tests`, survey: `${publicUrl()}/tester/tests` };
  const name = a ? await testerName(a) : null;
  const guide = [c.guide?.trim(), guideFiles.length > 0 ? `(Tệp hướng dẫn đính kèm: ${guideFiles.join(", ")})` : ""].filter(Boolean).join("\n");
  return {
    GAME_NAME: c.gameName,
    GAME_GENRE: c.genre ?? "",
    GAME_PLATFORM: c.platforms.join(", "),
    START_DATE: viDate(isoDate(c.startDate)),
    END_DATE: viDate(end),
    DAYS_LEFT: end ? String(Math.max(0, daysBetween(todayIct(), end))) : "",
    TEST_FORMAT: testFormat(c),
    RESPONSE_URL: links.response,
    RESPONSE_DEADLINE: viDate(responseDeadline(c, a?.invitedAt ?? null, settings)),
    GUIDE: guide,
    ACCESS_INFO: c.accessInfo?.trim() ?? "",
    APK_URL: c.apkFolderUrl ?? "",
    INSTALL_URL: c.installUrl ?? "",
    TEST_NOTE: c.testerNote?.trim() ?? "",
    SURVEY_URL: links.survey,
    TESTER_NAME: name || "bạn",
    COORDINATOR_NAME: c.coordinatorName ?? "Team New Game",
    CONTACT_EMAIL: c.coordinatorEmail || settings.senderEmail,
  };
}

const PARAM_RE = /\{\{\s*([A-Z_]+)\s*\}\}/g;

/** Dòng chứa tham số trống bị bỏ; tiêu đề **...** không còn nội dung bên dưới cũng bỏ. */
export function renderTemplate(subject: string, body: string, params: Record<string, string>) {
  const sub = (s: string) => s.replace(PARAM_RE, (_m, k: string) => params[k] ?? "");
  const kept: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const keys = [...line.matchAll(PARAM_RE)].map((m) => m[1]);
    if (keys.length > 0 && keys.some((k) => !params[k]?.trim())) continue;
    kept.push(line);
  }
  const isHeading = (l: string) => /^\*\*[^*]+\*\*$/.test(l.trim());
  const lines = kept.filter((l, i) => {
    if (!isHeading(l)) return true;
    const next = kept.slice(i + 1).find((x) => x.trim() !== "");
    return next !== undefined && !isHeading(next) && kept[i + 1]?.trim() !== "";
  });
  const text = sub(lines.join("\n")).replace(/\n{3,}/g, "\n\n").trim();
  return { subject: sub(subject).replace(/\s+/g, " ").trim(), text: text.replace(/\*\*([^*]+)\*\*/g, "$1"), html: toHtml(text) };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:)])/g, '<a href="$1" style="color:#5b3df5">$1</a>');
}

function toHtml(text: string): string {
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length > 0) out.push(`<ul style="margin:6px 0 10px 18px;padding:0">${list.map((x) => `<li>${x}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const para of text.split(/\n{2,}/)) {
    const rows = para.split("\n");
    const plain: string[] = [];
    for (const r of rows) {
      if (/^\s*[-•]\s+/.test(r)) {
        if (plain.length) {
          out.push(`<p style="margin:0 0 10px">${plain.map(inline).join("<br>")}</p>`);
          plain.length = 0;
        }
        list.push(inline(r.replace(/^\s*[-•]\s+/, "")));
      } else {
        flush();
        plain.push(r);
      }
    }
    flush();
    if (plain.length) out.push(`<p style="margin:0 0 10px">${plain.map(inline).join("<br>")}</p>`);
  }
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f1b3a;max-width:640px">${out.join("")}<p style="margin-top:18px;font-size:12px;color:#8a86a3">Mail tự động từ Game Test Bot — vui lòng không trả lời trực tiếp mail này.</p></div>`;
}

async function guideAttachments(campaignId: string): Promise<{ names: string[]; attachments: MailAttachment[] }> {
  const files = await prismaApp.testFile.findMany({ where: { campaignId, kind: "guide" }, orderBy: { createdAt: "asc" } });
  const attachments: MailAttachment[] = [];
  let total = 0;
  for (const f of files) {
    if (total + f.size > 15 * 1024 * 1024) break;
    try {
      attachments.push({ name: f.fileName, mimeType: f.mime, base64: fs.readFileSync(absolutePath(f.storagePath)).toString("base64") });
      total += f.size;
    } catch {
      /* tệp mất trên đĩa: bỏ qua đính kèm */
    }
  }
  return { names: files.map((f) => f.fileName), attachments };
}

export async function renderCampaignMail(code: string, c: Campaign, a: Assignment | null) {
  await ensureMailTemplates();
  const tpl = await prismaApp.testMailTemplate.findUnique({ where: { code } });
  if (!tpl) throw new TestGameError("Không có mẫu mail này", 404);
  const settings = await getSettings();
  const withGuide = code === "M3" || code === "M4";
  const guide = withGuide ? await guideAttachments(c.id) : { names: [], attachments: [] };
  const params = await mailParams(c, a, settings, guide.names);
  return { template: tpl, settings, attachments: guide.attachments, ...renderTemplate(tpl.subject, tpl.body, params) };
}

const SAMPLE_PARAMS: Record<string, string> = {
  GAME_NAME: "Tên game mẫu",
  GAME_GENRE: "Roguelike Platformer",
  GAME_PLATFORM: "Android, iOS",
  START_DATE: "01/12/2026",
  END_DATE: "07/12/2026",
  DAYS_LEFT: "2",
  TEST_FORMAT: "Chơi 2 giờ/ngày trong 3 ngày",
  RESPONSE_URL: "https://sourcing-web.run.ingarena.net/tester/tests/…",
  RESPONSE_DEADLINE: "28/11/2026",
  GUIDE: "Tải APK trong folder Drive, cài đặt và đăng nhập bằng tài khoản Google.",
  ACCESS_INFO: "Tài khoản test: tester01 / ******",
  APK_URL: "https://drive.google.com/drive/folders/…",
  INSTALL_URL: "",
  TEST_NOTE: "Tập trung vào 3 chương đầu và hệ thống gacha.",
  SURVEY_URL: "https://sourcing-web.run.ingarena.net/tester/tests/…/survey",
  TESTER_NAME: "Minh",
  COORDINATOR_NAME: "Team New Game",
  CONTACT_EMAIL: "testgame@garena.vn",
};

/** Xem trước mẫu (kể cả bản đang sửa chưa lưu) với dữ liệu thật của game test, hoặc dữ liệu mẫu. */
export async function previewMail(code: string, opts: { campaignId?: string | null; assignmentId?: string | null; subject?: string; body?: string }) {
  await ensureMailTemplates();
  const tpl = await prismaApp.testMailTemplate.findUnique({ where: { code } });
  if (!tpl) throw new TestGameError("Không có mẫu mail này", 404);
  const subject = opts.subject ?? tpl.subject;
  const body = opts.body ?? tpl.body;
  if (!opts.campaignId) return { ...renderTemplate(subject, body, SAMPLE_PARAMS), sample: true, to: null };
  const c = await prismaApp.testCampaign.findUnique({ where: { id: opts.campaignId } });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  const a = opts.assignmentId
    ? await prismaApp.testAssignment.findUnique({ where: { id: opts.assignmentId } })
    : await prismaApp.testAssignment.findFirst({ where: { campaignId: c.id }, orderBy: { createdAt: "asc" } });
  const settings = await getSettings();
  const guide = code === "M3" || code === "M4" ? await guideAttachments(c.id) : { names: [], attachments: [] };
  const params = await mailParams(c, a, settings, guide.names);
  return { ...renderTemplate(subject, body, params), sample: false, to: a?.email ?? null, attachments: guide.names };
}

export type SendResult = "sent" | "failed" | "skipped";

/**
 * Gửi một mốc mail cho một tester. Mỗi mốc gửi tối đa một lần (trừ `force` khi Admin bấm gửi lại);
 * mốc lỗi được thử lại ở lần chạy sau, tối đa 3 lần.
 */
export async function sendCampaignMail(
  code: string,
  c: Campaign,
  a: Assignment,
  opts: { trigger?: "auto" | "manual"; force?: boolean; actor?: string } = {},
): Promise<SendResult> {
  const existing = await prismaApp.testMailLog.findFirst({ where: { assignmentId: a.id, code, trigger: { not: "test" } }, orderBy: { sentAt: "desc" } });
  if (!opts.force && existing && (existing.status === "sent" || existing.attempts >= 3)) return "skipped";
  const mail = await renderCampaignMail(code, c, a);
  if (!mail.template.enabled) return "skipped";
  let status: "sent" | "failed" = "sent";
  let error: string | null = null;
  try {
    await sendMail({
      to: a.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      fromName: mail.settings.senderName,
      replyTo: c.coordinatorEmail,
      attachments: mail.attachments,
    });
  } catch (err) {
    status = "failed";
    error = (err as Error).message.slice(0, 500);
  }
  if (existing && existing.status === "failed" && !opts.force) {
    await prismaApp.testMailLog.update({
      where: { id: existing.id },
      data: { status, error, attempts: existing.attempts + 1, sentAt: new Date(), subject: mail.subject },
    });
  } else {
    await prismaApp.testMailLog.create({
      data: { campaignId: c.id, assignmentId: a.id, code, toEmail: a.email, subject: mail.subject, status, error, trigger: opts.trigger ?? "auto" },
    });
  }
  if (opts.trigger === "manual") await audit(c.id, opts.actor, "mail.resend", { code, to: a.email, status });
  return status;
}

export async function sendTestMail(code: string, c: Campaign, toEmail: string, actor: string) {
  const sample = await prismaApp.testAssignment.findFirst({ where: { campaignId: c.id }, orderBy: { createdAt: "asc" } });
  const mail = await renderCampaignMail(code, c, sample);
  let status: "sent" | "failed" = "sent";
  let error: string | null = null;
  try {
    await sendMail({
      to: toEmail,
      subject: `[Gửi thử] ${mail.subject}`,
      html: mail.html,
      text: mail.text,
      fromName: mail.settings.senderName,
      replyTo: c.coordinatorEmail,
      attachments: mail.attachments,
    });
  } catch (err) {
    status = "failed";
    error = (err as Error).message.slice(0, 500);
  }
  await prismaApp.testMailLog.create({
    data: { campaignId: c.id, assignmentId: null, code, toEmail, subject: mail.subject, status, error, trigger: "test" },
  });
  await audit(c.id, actor, "mail.test", { code, to: toEmail, status });
  if (status === "failed") throw new TestGameError(`Gửi thử lỗi: ${error}`, 502);
  return { sent: true };
}

/** Mốc mail kế tiếp chưa gửi: { code, date } hoặc null ("-"). */
export function nextMail(
  c: Pick<Campaign, "status" | "startDate" | "endDate" | "noTest">,
  sentCodes: Set<string>,
  settings: TestGameSettings,
  hasInvited: boolean,
  firstInvitedAt: Date | null,
): { code: string; date: string } | null {
  if (c.noTest) return null;
  const start = isoDate(c.startDate);
  const end = isoDate(c.endDate);
  if (!start || !end) return null;
  const plan: Array<{ code: string; date: string }> = [];
  if (c.status === "pending") return { code: "M1", date: "Khi Initiate" };
  if (!["inviting", "testing"].includes(c.status)) return null;
  if (hasInvited && firstInvitedAt) plan.push({ code: "M2", date: addDays(ictDateOf(firstInvitedAt)!, settings.remindAfterDays) });
  plan.push({ code: "M4", date: start });
  plan.push({ code: "M5", date: addDays(end, -settings.remindBeforeDays) });
  plan.push({ code: "M6", date: end });
  plan.push({ code: "M7", date: addDays(end, 1) });
  const today = todayIct();
  const next = plan.filter((p) => !sentCodes.has(p.code) && p.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  return next ?? null;
}
