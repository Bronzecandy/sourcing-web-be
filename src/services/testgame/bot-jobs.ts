import type { Prisma, TestBotJob } from "../../../generated/prisma-app/client";
import { prismaApp } from "../../utils/prisma-app";
import { audit } from "./common";
import { driveAvailable, enqueueBotJob, relayCall, type BotJobContext } from "./google-bot";

/** Kéo kết quả từ trạm khi còn việc chờ. Trạm tự báo hết hạn sau 6 giờ; STALE_MS là lưới an toàn khi trạm mất việc. */
const SYNC_MS = 20_000;
const STALE_MS = 7 * 60 * 60_000;

interface RelayResult {
  id: string;
  ok: boolean;
  result: unknown;
  error: string | null;
}

export async function queueDriveFolder(campaignId: string, parentId: string, name: string, actor: string): Promise<void> {
  await enqueueBotJob("createFolder", { parentId, name }, { kind: "folder", actor }, campaignId);
}

export async function folderJobPending(campaignId: string): Promise<boolean> {
  return (await prismaApp.testBotJob.count({ where: { campaignId, action: "createFolder", status: "queued" } })) > 0;
}

/** Share quyền xem folder APK; driveShare = "pending" tới khi bot báo kết quả. */
export async function queueDriveShare(campaignId: string, folderId: string, assignments: Array<{ id: string; email: string }>): Promise<void> {
  if (assignments.length === 0) return;
  const ids = assignments.map((a) => a.id);
  await prismaApp.testAssignment.updateMany({ where: { id: { in: ids } }, data: { driveShare: "pending" } });
  try {
    await enqueueBotJob("shareFolder", { folderId, emails: assignments.map((a) => a.email) }, { kind: "share", assignmentIds: ids }, campaignId);
  } catch (err) {
    await prismaApp.testAssignment.updateMany({ where: { id: { in: ids } }, data: { driveShare: (err as Error).message.slice(0, 200) } });
  }
}

/** Folder vừa tạo (hoặc tạo lại): share cho mọi tester đã xác nhận mà chưa có quyền. */
async function shareWithJoined(campaignId: string, folderId: string): Promise<void> {
  const joined = await prismaApp.testAssignment.findMany({
    where: { campaignId, status: { in: ["confirmed", "in_test", "submitted"] }, OR: [{ driveShare: null }, { driveShare: { not: "ok" } }] },
    select: { id: true, email: true },
  });
  await queueDriveShare(campaignId, folderId, joined);
}

async function applyResult(job: TestBotJob, ok: boolean, result: unknown, error: string | null): Promise<void> {
  const ctx = job.context as unknown as BotJobContext;
  const err = ok ? null : (error || "Bot báo lỗi không rõ").slice(0, 500);
  await prismaApp.testBotJob.update({
    where: { id: job.id },
    data: { status: ok ? "done" : "failed", error: err, result: (result ?? undefined) as Prisma.InputJsonValue | undefined, finishedAt: new Date() },
  });
  if (ctx.kind === "mail") {
    await prismaApp.testMailLog.updateMany({
      where: { id: ctx.mailLogId, status: "queued" },
      data: ok ? { status: "sent", error: null, sentAt: new Date() } : { status: "failed", error: err },
    });
    return;
  }
  if (!job.campaignId) return;
  if (ctx.kind === "folder") {
    const folder = ok ? (result as { id?: string; url?: string } | null) : null;
    if (folder?.id && folder.url) {
      const n = await prismaApp.testCampaign.updateMany({
        where: { id: job.campaignId },
        data: { apkFolderId: folder.id, apkFolderUrl: folder.url, apkFolderError: null },
      });
      if (n.count === 0) return;
      await audit(job.campaignId, ctx.actor, "drive.folder_created", { url: folder.url });
      await shareWithJoined(job.campaignId, folder.id);
    } else {
      await prismaApp.testCampaign.updateMany({ where: { id: job.campaignId }, data: { apkFolderError: (err ?? "Bot không trả về folder").slice(0, 300) } });
    }
    return;
  }
  const perEmail = ok ? ((result as { results?: Record<string, string> } | null)?.results ?? {}) : {};
  const rows = await prismaApp.testAssignment.findMany({ where: { id: { in: ctx.assignmentIds } }, select: { id: true, email: true } });
  for (const a of rows) {
    const share = ok ? (perEmail[a.email] ?? "ok") : (err ?? "Lỗi share folder");
    await prismaApp.testAssignment.update({ where: { id: a.id }, data: { driveShare: share.slice(0, 200) } });
  }
}

let syncing = false;

/** Áp kết quả bot đã trả về trạm cho các việc đang chờ; trả về số việc vừa áp. */
export async function syncBotJobs(): Promise<number> {
  if (syncing || !driveAvailable()) return 0;
  syncing = true;
  try {
    const open = await prismaApp.testBotJob.findMany({ where: { status: "queued" } });
    if (open.length === 0) return 0;
    const byId = new Map(open.map((j) => [j.id, j]));
    const { results } = await relayCall<{ results: RelayResult[] }>("GET", "/results");
    const ack: string[] = [];
    const others: string[] = [];
    let applied = 0;
    for (const r of results) {
      const job = byId.get(r.id);
      if (!job) {
        others.push(r.id);
        continue;
      }
      await applyResult(job, r.ok, r.result, r.error);
      byId.delete(r.id);
      ack.push(r.id);
      applied++;
    }
    // Chỉ ack việc của DB này (đã áp ở lần trước mà ack lỗi); việc lạ có thể của BE khác dùng chung trạm.
    if (others.length > 0) {
      const mine = await prismaApp.testBotJob.findMany({ where: { id: { in: others } }, select: { id: true } });
      ack.push(...mine.map((j) => j.id));
    }
    if (ack.length > 0) await relayCall("POST", "/ack", { ids: ack });

    const stale = [...byId.values()].filter((j) => Date.now() - j.createdAt.getTime() > STALE_MS);
    if (stale.length > 0) {
      const r = await relayCall<{ cancelled: string[]; unknown: string[] }>("POST", "/cancel", { ids: stale.map((j) => j.id) });
      for (const id of [...r.cancelled, ...r.unknown]) {
        const job = byId.get(id);
        if (job) await applyResult(job, false, null, "Bot Apps Script không xử lý việc này — kiểm tra trigger poll trong script");
      }
    }
    return applied;
  } catch (err) {
    console.warn("[testgame] bot sync:", (err as Error).message);
    return 0;
  } finally {
    syncing = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startBotJobSync(): void {
  if (timer) return;
  timer = setInterval(() => void syncBotJobs(), SYNC_MS);
  timer.unref();
}
