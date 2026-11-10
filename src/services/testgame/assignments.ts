import { prismaApp } from "../../utils/prisma-app";
import { testerRows } from "../tester-admin.service";
import { audit, normalizeEmail, parseEmailList, TestGameError } from "./common";
import { campaignDetail, devicesOf, sendInvitesInBackground } from "./campaigns";
import { SECURITY_LEVELS } from "./defaults";
import { deleteStoredFile } from "./files";
import { sendCampaignMail } from "./mail";
import { queueEvidenceReview } from "./evidence-ai";

function allowedTypes(level: string): readonly string[] {
  return SECURITY_LEVELS.find((s) => s.key === level)?.testerTypes ?? ["in_team", "staff", "collab"];
}

/** Gợi ý tester: lọc mức bảo mật + platform, điểm dòng chính ×1 / phụ ×0.5, Favorite, cảnh báo bận. */
export async function recommendTesters(campaignId: string, opts: { limit?: number; platformFilter?: boolean; securityFilter?: boolean } = {}) {
  const c = await prismaApp.testCampaign.findUnique({ where: { id: campaignId }, include: { assignments: { select: { email: true } } } });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  const main = c.mainTags;
  const secondary = c.secondaryTags.filter((t) => !main.includes(t));
  if (main.length === 0 && secondary.length === 0) throw new TestGameError("Game test chưa có dòng game");
  const assigned = new Set(c.assignments.map((a) => a.email));
  const devices = devicesOf(c.platforms);
  const types = allowedTypes(c.securityLevel);
  const rows = await testerRows();
  const profiles = await prismaApp.testerProfile.findMany({ where: { userId: { in: rows.map((r) => r.userId) } }, select: { userId: true, testerType: true } });
  const typeOf = new Map(profiles.map((p) => [p.userId, p.testerType ?? "staff"]));
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const busyRows =
    c.startDate && c.endDate
      ? await prismaApp.testAssignment.findMany({
          where: {
            campaignId: { not: c.id },
            status: { in: ["invited", "confirmed", "in_test"] },
            campaign: { status: { in: ["pending", "inviting", "testing"] }, startDate: { lte: c.endDate }, endDate: { gte: c.startDate } },
          },
          select: { email: true, campaign: { select: { gameName: true } } },
        })
      : [];
  const busy = new Map<string, string[]>();
  for (const b of busyRows) busy.set(b.email, [...(busy.get(b.email) ?? []), b.campaign.gameName]);
  return rows
    .filter((r) => r.active)
    .filter((r) => opts.securityFilter === false || types.includes(typeOf.get(r.userId) ?? "staff"))
    .filter((r) => opts.platformFilter === false || devices.length === 0 || r.platforms.some((p) => devices.includes(p)))
    .map((r) => {
      let sum = 0;
      let weight = 0;
      for (const t of main) {
        sum += r.scores[t] ?? 0;
        weight += 1;
      }
      for (const t of secondary) {
        sum += (r.scores[t] ?? 0) * 0.5;
        weight += 0.5;
      }
      const email = r.email.toLowerCase();
      return {
        userId: r.userId,
        name: r.name,
        email,
        score: weight > 0 ? Math.round(sum / weight) : 0,
        favorite: Boolean(r.favoriteGenre && main.includes(r.favoriteGenre)),
        platforms: r.platforms,
        testerType: typeOf.get(r.userId) ?? "staff",
        activeTests: r.stats.activeTests,
        completedHours: r.stats.completedHours,
        testTimeLabel: r.testTimeLabel,
        busyWith: busy.get(email) ?? [],
        assigned: assigned.has(email),
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.favorite) - Number(a.favorite) || a.busyWith.length - b.busyWith.length)
    .slice(0, limit);
}

/** Xem trước danh sách email dán vào: hợp lệ / sai / trùng / đã có, kèm cảnh báo bảo mật. */
export async function previewEmails(campaignId: string, raw: unknown) {
  const c = await prismaApp.testCampaign.findUnique({ where: { id: campaignId }, include: { assignments: { select: { email: true } } } });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  const parsed = parseEmailList(raw);
  const existing = new Set(c.assignments.map((a) => a.email));
  const users = await prismaApp.user.findMany({
    where: { email: { in: parsed.valid, mode: "insensitive" } },
    select: { email: true, name: true, testerProfile: { select: { name: true, testerType: true } } },
  });
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
  const types = allowedTypes(c.securityLevel);
  return {
    invalid: parsed.invalid,
    duplicates: parsed.duplicates,
    rows: parsed.valid.map((email) => {
      const u = byEmail.get(email);
      const type = u?.testerProfile?.testerType ?? (u?.testerProfile ? "staff" : null);
      return {
        email,
        name: u?.testerProfile?.name ?? u?.name ?? null,
        hasAccount: Boolean(u),
        hasProfile: Boolean(u?.testerProfile),
        testerType: type,
        securityWarning: type && !types.includes(type) ? `Mức bảo mật ${c.securityLevel} không dành cho tester ${type}` : null,
        exists: existing.has(email),
      };
    }),
  };
}

export async function addTesters(campaignId: string, body: { emails?: unknown; userIds?: unknown; invite?: unknown }, actor: string) {
  const c = await prismaApp.testCampaign.findUnique({ where: { id: campaignId }, include: { assignments: { select: { email: true } } } });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  if (c.noTest) throw new TestGameError("Game Không test không mời tester");
  if (["reporting", "done", "cancelled"].includes(c.status)) throw new TestGameError("Game test đã kết thúc, không thêm tester");
  const parsed = parseEmailList(body.emails ?? []);
  const userIds = Array.isArray(body.userIds) ? body.userIds.filter((x): x is string => typeof x === "string") : [];
  const fromUsers = userIds.length
    ? await prismaApp.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
    : [];
  const emails = [...new Set([...parsed.valid, ...fromUsers.map((u) => u.email.toLowerCase())])];
  const existing = new Set(c.assignments.map((a) => a.email));
  const fresh = emails.filter((e) => !existing.has(e));
  if (fresh.length === 0 && parsed.invalid.length === 0) throw new TestGameError("Không có email mới để thêm");
  const accounts = await prismaApp.user.findMany({ where: { email: { in: fresh, mode: "insensitive" } }, select: { id: true, email: true } });
  const idOf = new Map(accounts.map((u) => [u.email.toLowerCase(), u.id]));
  await prismaApp.testAssignment.createMany({
    data: fresh.map((email) => ({ campaignId, email, userId: idOf.get(email) ?? null, status: "added" })),
    skipDuplicates: true,
  });
  await audit(campaignId, actor, "testers.add", { emails: fresh });
  if (body.invite === true && c.initiatedAt && (c.status === "inviting" || c.status === "testing")) {
    await inviteAdded(campaignId, actor);
  }
  return { added: fresh.length, invalid: parsed.invalid, skipped: emails.length - fresh.length, detail: await campaignDetail(campaignId) };
}

/** "Gửi mời": M1 cho các tester mới thêm sau khi đã Initiate. */
export async function inviteAdded(campaignId: string, actor: string) {
  const c = await prismaApp.testCampaign.findUnique({ where: { id: campaignId } });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  if (!c.initiatedAt || !["inviting", "testing"].includes(c.status)) throw new TestGameError("Chỉ gửi mời khi game test đang Inviting / Testing");
  const added = await prismaApp.testAssignment.findMany({ where: { campaignId, status: "added" }, select: { id: true, email: true } });
  if (added.length === 0) throw new TestGameError("Không có tester mới chưa được mời");
  await prismaApp.testAssignment.updateMany({ where: { id: { in: added.map((a) => a.id) } }, data: { status: "invited", invitedAt: new Date() } });
  sendInvitesInBackground(c, added.map((a) => a.id), actor);
  await audit(campaignId, actor, "testers.invite", { emails: added.map((a) => a.email) });
  return campaignDetail(campaignId);
}

export async function updateAssignment(id: string, body: Record<string, unknown>, actor: string) {
  const a = await prismaApp.testAssignment.findUnique({ where: { id }, include: { campaign: true } });
  if (!a) throw new TestGameError("Không tìm thấy tester trong game test", 404);
  const data: Record<string, unknown> = {};
  if (body.email !== undefined) {
    const email = normalizeEmail(body.email);
    if (email !== a.email) {
      if (!["added", "invited", "no_response"].includes(a.status)) throw new TestGameError("Chỉ sửa email khi tester chưa phản hồi");
      if (!parseEmailList(email).valid.includes(email)) throw new TestGameError("Email không hợp lệ");
      const dup = await prismaApp.testAssignment.findFirst({ where: { campaignId: a.campaignId, email } });
      if (dup) throw new TestGameError("Email đã có trong game test");
      const u = await prismaApp.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } });
      data.email = email;
      data.userId = u?.id ?? null;
    }
  }
  if (body.note !== undefined) data.note = body.note ? String(body.note).slice(0, 2000) : null;
  if (body.whitelistInfo !== undefined) data.whitelistInfo = body.whitelistInfo ? String(body.whitelistInfo).slice(0, 2000) : null;
  if (body.workloadHours !== undefined) {
    if (body.workloadHours === null || body.workloadHours === "") data.workloadHours = null;
    else {
      const n = Number(body.workloadHours);
      if (!Number.isFinite(n) || n < 0) throw new TestGameError("Số giờ không hợp lệ");
      data.workloadHours = n;
    }
  }
  if (body.status !== undefined) {
    const s = String(body.status);
    if (!["confirmed", "declined", "no_response", "in_test"].includes(s)) throw new TestGameError("Trạng thái không hợp lệ");
    data.status = s;
    data.respondedAt = a.respondedAt ?? new Date();
  }
  await prismaApp.testAssignment.update({ where: { id }, data });
  await audit(a.campaignId, actor, "tester.update", { email: a.email, fields: Object.keys(data).filter((k) => k !== "userId") });
  if (data.email && a.status !== "added") {
    const fresh = await prismaApp.testAssignment.findUniqueOrThrow({ where: { id } });
    await sendCampaignMail("M1", a.campaign, fresh, { trigger: "manual", force: true, actor });
  }
  return campaignDetail(a.campaignId);
}

export async function removeAssignment(id: string, actor: string) {
  const a = await prismaApp.testAssignment.findUnique({ where: { id }, include: { files: { select: { id: true } } } });
  if (!a) throw new TestGameError("Không tìm thấy tester trong game test", 404);
  for (const f of a.files) await deleteStoredFile(f.id).catch(() => undefined);
  await prismaApp.testAssignment.delete({ where: { id } });
  await audit(a.campaignId, actor, "testers.remove", { email: a.email, status: a.status });
  return campaignDetail(a.campaignId);
}

/** Admin gửi lại một mốc mail (vd sửa email rồi Gửi lại M1). */
export async function resendMail(id: string, code: string, actor: string) {
  const a = await prismaApp.testAssignment.findUnique({ where: { id }, include: { campaign: true } });
  if (!a) throw new TestGameError("Không tìm thấy tester trong game test", 404);
  if (a.campaign.status === "cancelled") throw new TestGameError("Game test đã huỷ");
  if (["declined", "no_response"].includes(a.status) && code !== "M1") throw new TestGameError("Tester đã rút — không gửi mail");
  if (code === "M1" && a.status === "added") throw new TestGameError("Tester chưa được mời — bấm Gửi mời");
  const status = await sendCampaignMail(code, a.campaign, a, { trigger: "manual", force: true, actor });
  if (status === "skipped") throw new TestGameError(`Mẫu ${code} đang tắt`);
  if (status === "failed") {
    const log = await prismaApp.testMailLog.findFirst({ where: { assignmentId: id, code }, orderBy: { sentAt: "desc" } });
    throw new TestGameError(`Gửi lỗi: ${log?.error ?? "không rõ"}`, 502);
  }
  return campaignDetail(a.campaignId);
}

/** Duyệt bài nộp: approve → hoàn thành, tính giờ và benefit; reject → kèm lý do, tester nộp lại được. */
export async function reviewAssignment(id: string, body: { decision?: unknown; note?: unknown; workloadHours?: unknown }, actor: string) {
  const a = await prismaApp.testAssignment.findUnique({ where: { id }, include: { campaign: true } });
  if (!a) throw new TestGameError("Không tìm thấy tester trong game test", 404);
  const decision = String(body.decision ?? "");
  if (!["approve", "reject", "reset"].includes(decision)) throw new TestGameError("Quyết định duyệt không hợp lệ");
  if (decision !== "reset" && a.status !== "submitted") throw new TestGameError("Tester chưa nộp questionnaire");
  const note = body.note ? String(body.note).trim().slice(0, 1000) : null;
  if (decision === "reject" && !note) throw new TestGameError("Cần lý do khi không duyệt");
  const hours =
    body.workloadHours === undefined || body.workloadHours === "" || body.workloadHours === null ? undefined : Number(body.workloadHours);
  if (hours !== undefined && (!Number.isFinite(hours) || hours < 0)) throw new TestGameError("Số giờ không hợp lệ");
  const now = new Date();
  await prismaApp.testAssignment.update({
    where: { id },
    data:
      decision === "approve"
        ? { completed: true, completedAt: a.completedAt ?? now, reviewStatus: "approved", reviewNote: note, reviewedBy: actor, reviewedAt: now, ...(hours !== undefined ? { workloadHours: hours } : {}) }
        : decision === "reject"
          ? { completed: false, completedAt: null, reviewStatus: "rejected", reviewNote: note, reviewedBy: actor, reviewedAt: now }
          : { completed: false, completedAt: null, reviewStatus: a.status === "submitted" ? "pending" : null, reviewNote: null, reviewedBy: null, reviewedAt: null },
  });
  await audit(a.campaignId, actor, "tester.review", { email: a.email, decision, note, hours: hours ?? null });
  return campaignDetail(a.campaignId);
}

/** Duyệt hàng loạt các bài AI đề xuất duyệt. */
export async function approveRecommended(campaignId: string, actor: string) {
  const rows = await prismaApp.testAssignment.findMany({ where: { campaignId, status: "submitted", reviewStatus: "pending", aiStatus: "done" } });
  const ids = rows.filter((r) => (r.aiReview as { verdict?: string } | null)?.verdict === "approve").map((r) => r.id);
  for (const id of ids) await reviewAssignment(id, { decision: "approve", note: "Duyệt theo đề xuất AI" }, actor);
  return { approved: ids.length, detail: await campaignDetail(campaignId) };
}

export async function rerunEvidenceReview(id: string, actor: string) {
  const a = await prismaApp.testAssignment.findUnique({ where: { id }, select: { campaignId: true, status: true, email: true } });
  if (!a) throw new TestGameError("Không tìm thấy tester trong game test", 404);
  if (a.status !== "submitted") throw new TestGameError("Tester chưa nộp questionnaire");
  queueEvidenceReview(id);
  await audit(a.campaignId, actor, "tester.ai_review", { email: a.email });
  return campaignDetail(a.campaignId);
}

/** Lịch test theo tester (email): đang test, lịch sử, tổng giờ đã duyệt. */
export async function testerSchedule(email: string) {
  const rows = await prismaApp.testAssignment.findMany({
    where: { email: normalizeEmail(email) },
    include: { campaign: { select: { id: true, gameName: true, status: true, startDate: true, endDate: true, workloadHours: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    reviewStatus: r.reviewStatus,
    completed: r.completed,
    hours: r.workloadHours ?? r.campaign.workloadHours,
    campaign: { ...r.campaign, startDate: r.campaign.startDate?.toISOString().slice(0, 10) ?? null, endDate: r.campaign.endDate?.toISOString().slice(0, 10) ?? null },
  }));
}
