import nodemailer, { type Transporter } from "nodemailer";
import type { Prisma } from "../../../generated/prisma-app/client";
import { prismaApp } from "../../utils/prisma-app";

/**
 * Gửi mail + Drive bằng bot Apps Script chạy dưới testgame@garena.vn (scripts/apps-script/testgame-bot.gs).
 * Sea chỉ cho web app "Anyone within Sea" và BE nằm trong mạng nội bộ, nên hai bên không gọi thẳng nhau được:
 * BE đặt việc lên trạm `/bot` của taptap-proxy (VM data, TESTGAME_BOT_RELAY_URL), script ghé mỗi phút nhận việc
 * và trả kết quả; bot-jobs.ts lấy kết quả về áp vào mail log / folder / share.
 * SMTP (TESTGAME_SMTP_USER / TESTGAME_SMTP_PASS = App Password) chỉ gửi mail, dùng khi không cấu hình trạm.
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

export type BotAction = "sendMail" | "createFolder" | "shareFolder";

export type BotJobContext =
  | { kind: "mail"; mailLogId: string }
  | { kind: "folder"; actor: string }
  | { kind: "share"; assignmentIds: string[] };

function relayBase(): string | null {
  return process.env.TESTGAME_BOT_RELAY_URL?.trim().replace(/\/+$/, "") || null;
}

function relayKey(): string | null {
  return process.env.TESTGAME_BOT_RELAY_KEY?.trim() || process.env.TAPTAP_PROXY_KEY?.trim() || null;
}

function smtpAuth(): { user: string; pass: string } | null {
  const user = process.env.TESTGAME_SMTP_USER?.trim();
  const pass = process.env.TESTGAME_SMTP_PASS?.trim();
  return user && pass ? { user, pass } : null;
}

export function mailTransport(): "relay" | "smtp" | null {
  if (relayBase() && relayKey()) return "relay";
  if (smtpAuth()) return "smtp";
  return null;
}

export function driveAvailable(): boolean {
  return Boolean(relayBase() && relayKey());
}

export async function relayCall<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const base = relayBase();
  const key = relayKey();
  if (!base || !key) throw new Error("Chưa cấu hình trạm bot (TESTGAME_BOT_RELAY_URL)");
  const res = await fetch(`${base}/bot${path}`, {
    method,
    headers: { "x-api-key": key, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: { success?: boolean; data?: T; error?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Trạm bot trả về không phải JSON (HTTP ${res.status}): ${text.slice(0, 160)}`);
  }
  if (!res.ok || !json.success) throw new Error(json.error || `Trạm bot lỗi (HTTP ${res.status})`);
  return json.data as T;
}

/** Ghi việc vào DB rồi đặt lên trạm; đặt không được thì việc chốt failed và ném lỗi cho nơi gọi. */
export async function enqueueBotJob(action: BotAction, payload: Record<string, unknown>, context: BotJobContext, campaignId: string | null): Promise<string> {
  const job = await prismaApp.testBotJob.create({ data: { action, campaignId, context: context as unknown as Prisma.InputJsonValue } });
  try {
    await relayCall("POST", "/jobs", { id: job.id, action, payload });
  } catch (err) {
    const error = (err as Error).message.slice(0, 500);
    await prismaApp.testBotJob.update({ where: { id: job.id }, data: { status: "failed", error, finishedAt: new Date() } });
    throw err;
  }
  return job.id;
}

let smtp: Transporter | null = null;

/** Qua trạm: trả "queued", mail log cập nhật khi bot báo kết quả. SMTP: gửi ngay, trả "sent". */
export async function deliverMail(mail: OutgoingMail, mailLogId: string, campaignId: string | null): Promise<"queued" | "sent"> {
  const mode = mailTransport();
  if (mode === "relay") {
    await enqueueBotJob(
      "sendMail",
      {
        to: mail.to,
        subject: mail.subject,
        htmlBody: mail.html,
        body: mail.text,
        name: mail.fromName,
        replyTo: mail.replyTo ?? undefined,
        attachments: mail.attachments ?? [],
      },
      { kind: "mail", mailLogId },
      campaignId,
    );
    return "queued";
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
    return "sent";
  }
  throw new Error("Chưa cấu hình gửi mail (bot Apps Script qua trạm hoặc Gmail App Password)");
}

export interface BotStatus {
  transport: "relay" | "smtp" | null;
  drive: boolean;
  /** Bot Apps Script ghé trạm trong 3 phút gần nhất */
  online?: boolean;
  account?: string | null;
  quota?: number | null;
  lastPollAt?: string | null;
  /** Việc trên trạm chưa có kết quả */
  pending?: number;
  error?: string;
}

const ONLINE_MS = 3 * 60_000;

export async function botStatus(): Promise<BotStatus> {
  const transport = mailTransport();
  if (!driveAvailable()) return { transport, drive: false };
  try {
    const s = await relayCall<{
      lastPoll: { at: string; account: string | null; quota: number | null } | null;
      counts: { pending: number; claimed: number; finished: number };
    }>("GET", "/status");
    const lastPollAt = s.lastPoll?.at ?? null;
    const online = Boolean(lastPollAt && Date.now() - Date.parse(lastPollAt) < ONLINE_MS);
    return {
      transport,
      drive: true,
      online,
      account: s.lastPoll?.account ?? null,
      quota: s.lastPoll?.quota ?? null,
      lastPollAt,
      pending: s.counts.pending + s.counts.claimed,
      error: online
        ? undefined
        : lastPollAt
          ? "Bot Apps Script không ghé trạm hơn 3 phút — kiểm tra trigger poll trong script"
          : "Bot Apps Script chưa ghé trạm lần nào — chạy hàm setup() trong script",
    };
  } catch (err) {
    return { transport, drive: true, online: false, error: (err as Error).message };
  }
}
