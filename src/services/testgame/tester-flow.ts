import type { Prisma } from "../../../generated/prisma-app/client";
import type { AuthUserDto } from "../../types/auth";
import { prismaApp } from "../../utils/prisma-app";
import { genreLabel } from "../tester-config";
import { audit, getSettings, isoDate, normalizeEmail, TestGameError, todayIct } from "./common";
import { EVAL_FORMATS, labelOf } from "./defaults";
import { deleteStoredFile, fileDto, storeUpload, type FileKind, type UploadedTemp } from "./files";
import { shareDriveFolder } from "./google-bot";
import { queueEvidenceReview } from "./evidence-ai";
import { responseDeadline, sendCampaignMail } from "./mail";
import { campaignTemplate, cleanAnswers, type Answers } from "./templates";

type AssignmentFull = Prisma.TestAssignmentGetPayload<{ include: { campaign: { include: { report: { select: { status: true } } } }; files: true } }>;

/** Gắn dòng gán (theo email) vào tài khoản khi tester đăng nhập. */
async function linkUser(user: AuthUserDto): Promise<void> {
  await prismaApp.testAssignment.updateMany({ where: { email: normalizeEmail(user.email), userId: null }, data: { userId: user.id } });
}

async function loadOwn(user: AuthUserDto, id: string): Promise<AssignmentFull> {
  const a = await prismaApp.testAssignment.findUnique({
    where: { id },
    include: { campaign: { include: { report: { select: { status: true } } } }, files: { orderBy: { createdAt: "asc" } } },
  });
  if (!a || a.email !== normalizeEmail(user.email)) {
    throw new TestGameError(`Không có lời mời test nào cho ${user.email}. Hãy đăng nhập đúng email nhận mail mời.`, 404);
  }
  if (!a.userId) await prismaApp.testAssignment.update({ where: { id }, data: { userId: user.id } });
  return a;
}

function canRespond(a: AssignmentFull, deadline: string): boolean {
  const c = a.campaign;
  if (!["invited", "no_response", "declined"].includes(a.status)) return false;
  if (c.status === "inviting") return true;
  const start = isoDate(c.startDate);
  const lateInvite = Boolean(start && a.invitedAt && todayIct(a.invitedAt) >= start);
  return c.status === "testing" && lateInvite && todayIct() <= deadline && a.status !== "no_response";
}

function surveyState(a: AssignmentFull) {
  const c = a.campaign;
  const locked = c.report?.status === "locked" || c.status === "done";
  const open = ["testing", "reporting"].includes(c.status) && ["in_test", "submitted"].includes(a.status) && !locked;
  const editable = open && a.reviewStatus !== "approved";
  return { open, editable, locked };
}

/** Bước tiếp theo hiển thị cho tester. */
function nextAction(a: AssignmentFull, respondable: boolean): { key: string; label: string } {
  const c = a.campaign;
  const s = surveyState(a);
  if (c.status === "cancelled") return { key: "cancelled", label: "Đợt test đã huỷ" };
  if (respondable) return { key: "respond", label: "Xác nhận tham gia" };
  if (a.status === "declined") return { key: "declined", label: "Bạn đã từ chối" };
  if (a.status === "no_response") return { key: "expired", label: "Đã quá hạn phản hồi" };
  if (a.status === "confirmed") return { key: "wait_start", label: "Chờ ngày bắt đầu test" };
  if (a.status === "in_test") return s.open ? { key: "survey", label: "Làm questionnaire" } : { key: "closed", label: "Đã đóng nhận bài" };
  if (a.status === "submitted") {
    if (a.reviewStatus === "approved") return { key: "approved", label: "Đã duyệt hoàn thành" };
    if (a.reviewStatus === "rejected") return s.editable ? { key: "resubmit", label: "Cần nộp lại bằng chứng" } : { key: "rejected", label: "Không được duyệt" };
    return { key: "reviewing", label: "Đã nộp — chờ duyệt" };
  }
  return { key: "none", label: "" };
}

async function testerDto(a: AssignmentFull) {
  const c = a.campaign;
  const settings = await getSettings();
  const deadline = responseDeadline(c, a.invitedAt, settings);
  const respondable = canRespond(a, deadline);
  const joined = ["confirmed", "in_test", "submitted"].includes(a.status);
  const s = surveyState(a);
  return {
    id: a.id,
    status: a.status,
    invitedAt: a.invitedAt?.toISOString() ?? null,
    respondedAt: a.respondedAt?.toISOString() ?? null,
    submittedAt: a.submittedAt?.toISOString() ?? null,
    responseDeadline: deadline,
    canRespond: respondable,
    surveyOpen: s.open,
    surveyEditable: s.editable,
    reviewStatus: a.reviewStatus,
    reviewNote: a.reviewStatus === "rejected" ? a.reviewNote : null,
    completed: a.completed,
    hours: a.workloadHours ?? c.workloadHours,
    whitelistInfo: a.whitelistInfo,
    nextAction: nextAction(a, respondable),
    evidenceCount: a.files.filter((f) => f.kind === "evidence").length,
    campaign: {
      id: c.id,
      gameName: c.gameName,
      originalName: c.originalName,
      testRound: c.testRound,
      iconUrl: c.iconUrl,
      genre: c.genre,
      mainTags: c.mainTags.map(genreLabel),
      platforms: c.platforms,
      status: c.status,
      startDate: isoDate(c.startDate),
      endDate: isoDate(c.endDate),
      evalFormat: labelOf(EVAL_FORMATS, c.evalFormat),
      hoursPerDay: c.hoursPerDay,
      testDays: c.testDays,
      focusedAt: c.focusedAt?.toISOString() ?? null,
      focusedPlace: c.focusedPlace,
      background: c.background,
      taptapUrl: c.taptapUrl,
      coordinatorName: c.coordinatorName,
      coordinatorEmail: c.coordinatorEmail,
      footageRequired: c.footageRequired,
      // Hướng dẫn, link tải và thông tin truy cập chỉ hiện khi đã xác nhận tham gia.
      guide: joined ? c.guide : null,
      testerNote: joined ? c.testerNote : null,
      apkFolderUrl: joined ? c.apkFolderUrl : null,
      installUrl: joined ? c.installUrl : null,
      accessInfo: joined ? c.accessInfo : null,
      guideFiles: joined ? (await prismaApp.testFile.findMany({ where: { campaignId: c.id, kind: "guide" } })).map(fileDto) : [],
    },
  };
}

export async function myTestGames(user: AuthUserDto) {
  await linkUser(user);
  const rows = await prismaApp.testAssignment.findMany({
    where: { email: normalizeEmail(user.email), status: { not: "added" } },
    include: { campaign: { include: { report: { select: { status: true } } } }, files: { select: { kind: true } } },
    orderBy: { createdAt: "desc" },
  });
  return Promise.all(rows.map((r) => testerDto(r as unknown as AssignmentFull)));
}

export async function myTestGame(user: AuthUserDto, id: string) {
  const a = await loadOwn(user, id);
  if (a.status === "added") throw new TestGameError("Lời mời chưa được gửi", 404);
  return testerDto(a);
}

export async function respondInvite(user: AuthUserDto, id: string, body: { action?: unknown; whitelistInfo?: unknown }) {
  const a = await loadOwn(user, id);
  const settings = await getSettings();
  const deadline = responseDeadline(a.campaign, a.invitedAt, settings);
  if (!canRespond(a, deadline)) {
    throw new TestGameError(
      a.campaign.status === "testing" ? "Đợt test đã bắt đầu — không nhận phản hồi mới" : "Lời mời đã hết hạn hoặc đã được phản hồi",
      409,
    );
  }
  const action = String(body.action ?? "");
  if (action !== "confirm" && action !== "decline") throw new TestGameError("Chọn Xác nhận hoặc Từ chối");
  const whitelistInfo = body.whitelistInfo ? String(body.whitelistInfo).trim().slice(0, 1000) : a.whitelistInfo;
  const testing = a.campaign.status === "testing";
  const status = action === "decline" ? "declined" : testing ? "in_test" : "confirmed";
  const updated = await prismaApp.testAssignment.update({
    where: { id },
    data: { status, respondedAt: new Date(), whitelistInfo, userId: user.id },
  });
  if (action === "confirm" && !user.roles.includes("TESTER")) {
    await prismaApp.user.update({ where: { id: user.id }, data: { roles: { push: "TESTER" } } }).catch(() => undefined);
  }
  await audit(a.campaignId, user.email, "tester.respond", { email: a.email, action, late: a.status === "no_response" });
  if (action === "confirm") {
    const c = a.campaign;
    void (async () => {
      await sendCampaignMail("M3", c, updated).catch((e) => console.error("[testgame] M3", e));
      if (testing) await sendCampaignMail("M4", c, updated).catch((e) => console.error("[testgame] M4", e));
      if (c.apkFolderId) {
        try {
          const r = await shareDriveFolder(c.apkFolderId, [a.email]);
          await prismaApp.testAssignment.update({ where: { id }, data: { driveShare: r[a.email] ?? "ok" } });
        } catch (err) {
          await prismaApp.testAssignment.update({ where: { id }, data: { driveShare: (err as Error).message.slice(0, 200) } });
        }
      }
    })();
  }
  return myTestGame(user, id);
}

export async function surveyForm(user: AuthUserDto, id: string) {
  const a = await loadOwn(user, id);
  const tpl = await campaignTemplate(a.campaign);
  if (!tpl) throw new TestGameError("Game test chưa có questionnaire", 404);
  const settings = await getSettings();
  const s = surveyState(a);
  return {
    assignment: await testerDto(a),
    questions: tpl.questions,
    tags: tpl.tags,
    answers: (a.answers ?? {}) as Answers,
    answersUpdatedAt: a.answersUpdatedAt?.toISOString() ?? null,
    evidence: a.files.filter((f) => f.kind === "evidence").map(fileDto),
    footage: a.files.filter((f) => f.kind === "footage").map(fileDto),
    evidenceMax: settings.evidenceMax,
    footageMaxMb: settings.footageMaxMb,
    open: s.open,
    editable: s.editable,
    locked: s.locked,
  };
}

export async function saveSurvey(user: AuthUserDto, id: string, body: { answers?: unknown; submit?: unknown }) {
  const a = await loadOwn(user, id);
  const s = surveyState(a);
  if (!s.open) throw new TestGameError(s.locked ? "Report đã chốt — không nhận bài nữa" : "Questionnaire chưa mở hoặc bạn chưa xác nhận tham gia", 409);
  if (!s.editable) throw new TestGameError("Bài đã được duyệt — không sửa được", 409);
  const tpl = await campaignTemplate(a.campaign);
  if (!tpl) throw new TestGameError("Game test chưa có questionnaire", 404);
  const submit = body.submit === true;
  const footageFiles = a.files.filter((f) => f.kind === "footage").length;
  const evidence = a.files.filter((f) => f.kind === "evidence").length;
  const { answers, issues } = cleanAnswers(tpl, body.answers, { footageRequired: a.campaign.footageRequired, footageFiles, draft: !submit });
  if (submit && evidence === 0) issues.unshift("Ảnh bằng chứng: cần ít nhất 1 ảnh có UID và level / tiến trình");
  if (submit && issues.length > 0) throw new TestGameError("Còn câu bắt buộc chưa trả lời", 400, issues);
  const now = new Date();
  await prismaApp.testAssignment.update({
    where: { id },
    data: submit
      ? {
          answers: answers as Prisma.InputJsonValue,
          answersUpdatedAt: now,
          status: "submitted",
          submittedAt: now,
          reviewStatus: "pending",
          reviewNote: null,
          reviewedBy: null,
          reviewedAt: null,
        }
      : { answers: answers as Prisma.InputJsonValue, answersUpdatedAt: now },
  });
  if (submit) {
    await audit(a.campaignId, user.email, a.status === "submitted" ? "survey.resubmit" : "survey.submit", { email: a.email, evidence });
    queueEvidenceReview(id);
  }
  return surveyForm(user, id);
}

export async function uploadTesterFile(user: AuthUserDto, id: string, kind: string, file: UploadedTemp | undefined) {
  if (!file) throw new TestGameError("Chưa chọn tệp");
  if (kind !== "evidence" && kind !== "footage") throw new TestGameError("Loại tệp không hợp lệ");
  const a = await loadOwn(user, id);
  const s = surveyState(a);
  if (!s.editable) throw new TestGameError("Questionnaire đang đóng hoặc bài đã được duyệt", 409);
  const settings = await getSettings();
  if (kind === "evidence" && a.files.filter((f) => f.kind === "evidence").length >= settings.evidenceMax) {
    throw new TestGameError(`Tối đa ${settings.evidenceMax} ảnh bằng chứng — xoá bớt ảnh cũ trước`);
  }
  if (kind === "footage" && a.files.filter((f) => f.kind === "footage").length >= 10) throw new TestGameError("Tối đa 10 tệp footage");
  const saved = await storeUpload({ campaignId: a.campaignId, assignmentId: a.id, kind: kind as FileKind, file, uploadedBy: user.email, footageMaxMb: settings.footageMaxMb });
  if (kind === "evidence" && a.status === "submitted") {
    await prismaApp.testAssignment.update({ where: { id }, data: { reviewStatus: "pending", reviewNote: null } });
    queueEvidenceReview(id);
  }
  return fileDto(saved);
}

export async function deleteTesterFile(user: AuthUserDto, fileId: string) {
  const f = await prismaApp.testFile.findUnique({ where: { id: fileId }, include: { assignment: true } });
  if (!f?.assignment) throw new TestGameError("Không tìm thấy tệp", 404);
  const a = await loadOwn(user, f.assignment.id);
  if (!surveyState(a).editable) throw new TestGameError("Bài đã được duyệt hoặc questionnaire đã đóng", 409);
  await deleteStoredFile(fileId);
  return { deleted: true };
}

/** Quyền xem tệp: Admin Test Game, chủ tệp, hoặc tester đã xác nhận (tệp hướng dẫn). */
export async function fileAccess(user: AuthUserDto | undefined, fileId: string, isAdmin: boolean) {
  const f = await prismaApp.testFile.findUnique({ where: { id: fileId }, include: { assignment: { select: { email: true } } } });
  if (!f) throw new TestGameError("Không tìm thấy tệp", 404);
  if (isAdmin) return f;
  if (!user) throw new TestGameError("Cần đăng nhập", 401);
  const email = normalizeEmail(user.email);
  if (f.assignment?.email === email) return f;
  if (f.kind === "guide") {
    const joined = await prismaApp.testAssignment.findFirst({
      where: { campaignId: f.campaignId, email, status: { in: ["confirmed", "in_test", "submitted"] } },
      select: { id: true },
    });
    if (joined) return f;
  }
  throw new TestGameError("Không có quyền xem tệp này", 403);
}
