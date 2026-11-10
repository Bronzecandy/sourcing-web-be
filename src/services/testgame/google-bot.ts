import nodemailer, { type Transporter } from "nodemailer";

/**
 * Gửi mail + Drive qua Apps Script web app chạy dưới testgame@garena.vn
 * (scripts/apps-script/testgame-bot.gs). Gmail có 2FA nên mật khẩu thường không SMTP được;
 * SMTP chỉ dùng khi có App Password (TESTGAME_SMTP_USER / TESTGAME_SMTP_PASS).
 */

export interface MailAttachment {
  name: string;
  mimeType: string;
  base64: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName: string;
  replyTo?: string | null;
  attachments?: MailAttachment[];
}

function scriptUrl(): string | null {
  return process.env.TESTGAME_APPS_SCRIPT_URL?.trim() || null;
}

function scriptSecret(): string | null {
  return process.env.TESTGAME_APPS_SCRIPT_SECRET?.trim() || null;
}

function smtpAuth(): { user: string; pass: string } | null {
  const user = process.env.TESTGAME_SMTP_USER?.trim();
  const pass = process.env.TESTGAME_SMTP_PASS?.trim();
  return user && pass ? { user, pass } : null;
}

export function mailTransport(): "apps_script" | "smtp" | null {
  if (scriptUrl() && scriptSecret()) return "apps_script";
  if (smtpAuth()) return "smtp";
  return null;
}

export function driveAvailable(): boolean {
  return Boolean(scriptUrl() && scriptSecret());
}

async function callScript<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const url = scriptUrl();
  const secret = scriptSecret();
  if (!url || !secret) throw new Error("Chưa cấu hình TESTGAME_APPS_SCRIPT_URL / TESTGAME_APPS_SCRIPT_SECRET");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, action, ...payload }),
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: { ok?: boolean; error?: string } & Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Apps Script trả về không phải JSON (HTTP ${res.status}): ${text.slice(0, 160)}`);
  }
  if (!json.ok) throw new Error(json.error || `Apps Script lỗi (HTTP ${res.status})`);
  return json as T;
}

let smtp: Transporter | null = null;

export async function sendMail(mail: OutgoingMail): Promise<void> {
  const mode = mailTransport();
  if (mode === "apps_script") {
    await callScript("sendMail", {
      to: mail.to,
      subject: mail.subject,
      htmlBody: mail.html,
      body: mail.text,
      name: mail.fromName,
      replyTo: mail.replyTo ?? undefined,
      attachments: mail.attachments ?? [],
    });
    return;
  }
  if (mode === "smtp") {
    const auth = smtpAuth()!;
    smtp ??= nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth });
    await smtp.sendMail({
      from: { name: mail.fromName, address: auth.user },
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      replyTo: mail.replyTo ?? undefined,
      attachments: (mail.attachments ?? []).map((a) => ({ filename: a.name, contentType: a.mimeType, content: Buffer.from(a.base64, "base64") })),
    });
    return;
  }
  throw new Error("Chưa cấu hình gửi mail (Apps Script hoặc Gmail App Password)");
}

export async function createDriveFolder(parentId: string, name: string): Promise<{ id: string; url: string }> {
  const r = await callScript<{ id: string; url: string }>("createFolder", { parentId, name });
  return { id: r.id, url: r.url };
}

export async function shareDriveFolder(folderId: string, emails: string[]): Promise<Record<string, string>> {
  const r = await callScript<{ results: Record<string, string> }>("shareFolder", { folderId, emails });
  return r.results ?? {};
}

export async function botStatus(): Promise<{ transport: string | null; drive: boolean; account?: string; quota?: number; error?: string }> {
  const transport = mailTransport();
  if (!driveAvailable()) return { transport, drive: false };
  try {
    const r = await callScript<{ email?: string; quota?: number }>("ping", {});
    return { transport, drive: true, account: r.email, quota: r.quota };
  } catch (err) {
    return { transport, drive: false, error: (err as Error).message };
  }
}
