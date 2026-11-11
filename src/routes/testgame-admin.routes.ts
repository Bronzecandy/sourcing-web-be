import crypto from "crypto";
import path from "path";
import { Router, type Response } from "express";
import multer from "multer";
import type { AuthedRequest } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { prismaApp } from "../utils/prisma-app";
import { testerConfig } from "../services/tester-config";
import { getSettings, saveSettings, TestGameError } from "../services/testgame/common";
import {
  DECISIONS,
  EVAL_FORMATS,
  MAIL_PARAMS,
  PLATFORMS,
  QUESTION_KEYS,
  QUESTION_ROLES,
  QUESTION_TYPES,
  SECURITY_LEVELS,
  SOURCES,
  TESTER_TYPES,
} from "../services/testgame/defaults";
import {
  campaignAudit,
  campaignDetail,
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  finishNoTest,
  initiateCampaign,
  listCampaigns,
  previousCampaignOptions,
  reopenCampaign,
  resendSeaTalk,
  retryDriveFolder,
  updateCampaign,
} from "../services/testgame/campaigns";
import {
  addTesters,
  approveRecommended,
  inviteAdded,
  previewEmails,
  recommendTesters,
  removeAssignment,
  rerunEvidenceReview,
  resendMail,
  reviewAssignment,
  testerSchedule,
  updateAssignment,
} from "../services/testgame/assignments";
import { absolutePath, deleteStoredFile, fileDto, storeUpload, uploadTmpDir } from "../services/testgame/files";
import { syncBotJobs } from "../services/testgame/bot-jobs";
import { botStatus } from "../services/testgame/google-bot";
import { listMailTemplates, previewMail, saveMailTemplate, sendTestMail } from "../services/testgame/mail";
import {
  createShareKey,
  exportReportXlsx,
  getReport,
  listShareKeys,
  lockReport,
  revokeShareKey,
  saveRun,
  startConfigRun,
  startSummaryRun,
  unlockReport,
  updateReport,
} from "../services/testgame/report";
import { runTestGameSchedule, schedulerStatus } from "../services/testgame/scheduler";
import { cloneTemplate, deleteTag, deleteTemplate, getTemplate, listTags, listTemplates, saveTag, saveTemplate } from "../services/testgame/templates";

/** /api/testgame/admin — apiPermissionGuard đã chặn theo quyền tester.manage. */
const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadTmpDir()),
    filename: (_req, file, cb) => cb(null, `${crypto.randomBytes(8).toString("hex")}${path.extname(file.originalname).slice(0, 10)}`),
  }),
  limits: { fileSize: 1024 * 1024 * 1024, files: 5 },
});

export function testGameHandle(res: Response, fn: () => Promise<unknown> | unknown): void {
  Promise.resolve()
    .then(fn)
    .then((data) => res.json({ success: true, data }))
    .catch((err) => {
      if (err instanceof TestGameError) {
        res.status(err.status).json({ success: false, error: err.message, issues: err.issues });
        return;
      }
      if ((err as { code?: string }).code === "P2025") {
        res.status(404).json({ success: false, error: "Không tìm thấy bản ghi" });
        return;
      }
      if ((err as { code?: string }).code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ success: false, error: "Tệp quá lớn" });
        return;
      }
      console.error("[testgame-admin]", err);
      res.status(500).json({ success: false, error: "Lỗi module Test Game" });
    });
}

const handle = testGameHandle;
const actor = (req: AuthedRequest) => req.authUser!.email;

router.get("/meta", (_req, res) =>
  handle(res, async () => ({
    genres: testerConfig.genres().map((g) => ({ key: g.key, label: g.label, workloadGroup: g.workloadGroup })),
    workload: testerConfig.workload().groups,
    platforms: PLATFORMS,
    sources: SOURCES,
    securityLevels: SECURITY_LEVELS,
    testerTypes: TESTER_TYPES,
    evalFormats: EVAL_FORMATS,
    decisions: DECISIONS,
    mailParams: MAIL_PARAMS,
    questionTypes: QUESTION_TYPES,
    questionRoles: QUESTION_ROLES,
    questionKeys: QUESTION_KEYS,
    templates: (await listTemplates()).map((t) => ({ id: t.id, name: t.name, genres: t.genres, isBase: t.isBase, status: t.status, version: t.version })),
    tags: await listTags(),
    bot: await botStatus(),
  })),
);

router.get("/campaigns", (req, res) => handle(res, () => listCampaigns(req.query)));
router.get("/campaign-options", (req, res) => handle(res, () => previousCampaignOptions(String(req.query.q ?? ""))));
router.post("/campaigns", (req: AuthedRequest, res) => handle(res, () => createCampaign(req.body ?? {}, actor(req))));
router.get("/campaigns/:id", (req, res) => handle(res, () => campaignDetail(String(req.params.id))));
router.patch("/campaigns/:id", (req: AuthedRequest, res) => handle(res, () => updateCampaign(String(req.params.id), req.body ?? {}, actor(req))));
router.delete("/campaigns/:id", (req: AuthedRequest, res) => handle(res, () => deleteCampaign(String(req.params.id), actor(req))));
router.post("/campaigns/:id/initiate", (req: AuthedRequest, res) => handle(res, () => initiateCampaign(String(req.params.id), actor(req))));
router.post("/campaigns/:id/cancel", (req: AuthedRequest, res) => handle(res, () => cancelCampaign(String(req.params.id), actor(req))));
router.post("/campaigns/:id/reopen", (req: AuthedRequest, res) => handle(res, () => reopenCampaign(String(req.params.id), actor(req))));
router.post("/campaigns/:id/finish", (req: AuthedRequest, res) => handle(res, () => finishNoTest(String(req.params.id), req.body ?? {}, actor(req))));
router.post("/campaigns/:id/drive-folder", (req: AuthedRequest, res) => handle(res, () => retryDriveFolder(String(req.params.id), actor(req))));
router.post("/campaigns/:id/seatalk", (req: AuthedRequest, res) => handle(res, () => resendSeaTalk(String(req.params.id), actor(req))));
router.get("/campaigns/:id/audit", (req, res) => handle(res, () => campaignAudit(String(req.params.id))));

router.post("/campaigns/:id/guide-files", upload.single("file"), (req: AuthedRequest, res) =>
  handle(res, async () => {
    if (!req.file) throw new TestGameError("Chưa chọn tệp");
    const settings = await getSettings();
    const f = await storeUpload({ campaignId: String(req.params.id), assignmentId: null, kind: "guide", file: req.file, uploadedBy: actor(req), footageMaxMb: settings.footageMaxMb });
    return fileDto(f);
  }),
);
router.delete("/files/:fileId", (req, res) => handle(res, async () => (await deleteStoredFile(String(req.params.fileId)), { deleted: true })));
router.get("/files/:fileId", async (req, res) => {
  const f = await prismaApp.testFile.findUnique({ where: { id: String(req.params.fileId) } });
  if (!f) {
    res.status(404).json({ success: false, error: "Không tìm thấy tệp" });
    return;
  }
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(absolutePath(f.storagePath), (err) => {
    if (err && !res.headersSent) res.status(404).json({ success: false, error: "Tệp không còn trên máy chủ" });
  });
});

router.get("/campaigns/:id/recommend", (req, res) =>
  handle(res, () =>
    recommendTesters(String(req.params.id), {
      limit: Number(req.query.limit) || 10,
      platformFilter: req.query.platform !== "0",
      securityFilter: req.query.security !== "0",
    }),
  ),
);
router.post("/campaigns/:id/emails/preview", (req, res) => handle(res, () => previewEmails(String(req.params.id), req.body?.emails)));
router.post("/campaigns/:id/testers", (req: AuthedRequest, res) => handle(res, () => addTesters(String(req.params.id), req.body ?? {}, actor(req))));
router.post("/campaigns/:id/invite", (req: AuthedRequest, res) => handle(res, () => inviteAdded(String(req.params.id), actor(req))));
router.post("/campaigns/:id/approve-recommended", (req: AuthedRequest, res) => handle(res, () => approveRecommended(String(req.params.id), actor(req))));
router.patch("/assignments/:id", (req: AuthedRequest, res) => handle(res, () => updateAssignment(String(req.params.id), req.body ?? {}, actor(req))));
router.delete("/assignments/:id", (req: AuthedRequest, res) => handle(res, () => removeAssignment(String(req.params.id), actor(req))));
router.post("/assignments/:id/review", (req: AuthedRequest, res) => handle(res, () => reviewAssignment(String(req.params.id), req.body ?? {}, actor(req))));
router.post("/assignments/:id/ai-review", (req: AuthedRequest, res) => handle(res, () => rerunEvidenceReview(String(req.params.id), actor(req))));
router.post("/assignments/:id/resend", (req: AuthedRequest, res) => handle(res, () => resendMail(String(req.params.id), String(req.body?.code ?? "M1"), actor(req))));

router.post("/mail-preview", (req, res) =>
  handle(res, () =>
    previewMail(String(req.body?.code ?? "M1"), {
      campaignId: req.body?.campaignId ?? null,
      assignmentId: req.body?.assignmentId ?? null,
      subject: typeof req.body?.subject === "string" ? req.body.subject : undefined,
      body: typeof req.body?.body === "string" ? req.body.body : undefined,
    }),
  ),
);
router.post("/campaigns/:id/mail-test", (req: AuthedRequest, res) =>
  handle(res, async () => {
    const c = await prismaApp.testCampaign.findUnique({ where: { id: String(req.params.id) } });
    if (!c) throw new TestGameError("Không tìm thấy game test", 404);
    return sendTestMail(String(req.body?.code ?? "M1"), c, actor(req), actor(req));
  }),
);
router.get("/mail-templates", (_req, res) => handle(res, () => listMailTemplates()));
router.patch("/mail-templates/:code", (req: AuthedRequest, res) => handle(res, () => saveMailTemplate(String(req.params.code), req.body ?? {}, actor(req))));

router.get("/templates", (_req, res) => handle(res, () => listTemplates()));
router.get("/templates/:id", (req, res) => handle(res, () => getTemplate(String(req.params.id))));
router.post("/templates", (req: AuthedRequest, res) => handle(res, () => saveTemplate(req.body ?? {}, actor(req))));
router.post("/templates/clone", (req: AuthedRequest, res) => handle(res, () => cloneTemplate(req.body ?? {}, actor(req))));
router.delete("/templates/:id", (req: AuthedRequest, res) => handle(res, () => deleteTemplate(String(req.params.id), actor(req))));
router.get("/tags", (_req, res) => handle(res, () => listTags()));
router.post("/tags", (req: AuthedRequest, res) => handle(res, () => saveTag(req.body ?? {}, actor(req))));
router.delete("/tags/:name", (req: AuthedRequest, res) => handle(res, () => deleteTag(String(req.params.name), actor(req))));

router.get("/settings", (_req, res) =>
  handle(res, async () => {
    await syncBotJobs();
    return { settings: await getSettings(), bot: await botStatus(), scheduler: await schedulerStatus() };
  }),
);
router.patch("/settings", (req: AuthedRequest, res) => handle(res, () => saveSettings(req.body ?? {}, actor(req))));
router.post("/scheduler/run", (req: AuthedRequest, res) => handle(res, () => runTestGameSchedule({ actor: actor(req) })));

router.get("/campaigns/:id/report", (req, res) => handle(res, () => getReport(String(req.params.id))));
router.patch("/campaigns/:id/report", (req: AuthedRequest, res) => handle(res, () => updateReport(String(req.params.id), req.body ?? {}, actor(req))));
router.post("/campaigns/:id/report/summarize", (req: AuthedRequest, res) => handle(res, () => startSummaryRun(String(req.params.id), actor(req))));
router.post("/campaigns/:id/report/runs/:runId/save", (req: AuthedRequest, res) =>
  handle(res, () => saveRun(String(req.params.id), String(req.params.runId), req.body ?? {}, actor(req))),
);
router.post("/campaigns/:id/report/config", (req: AuthedRequest, res) => handle(res, () => startConfigRun(String(req.params.id), actor(req))));
router.post("/campaigns/:id/report/lock", (req: AuthedRequest, res) => handle(res, () => lockReport(String(req.params.id), actor(req))));
router.post("/campaigns/:id/report/unlock", (req: AuthedRequest, res) => handle(res, () => unlockReport(String(req.params.id), actor(req))));
router.get("/campaigns/:id/share", (req, res) => handle(res, () => listShareKeys(String(req.params.id))));
router.post("/campaigns/:id/share", (req: AuthedRequest, res) => handle(res, () => createShareKey(String(req.params.id), req.body ?? {}, actor(req))));
router.delete("/campaigns/:id/share/:shareId", (req: AuthedRequest, res) => handle(res, () => revokeShareKey(String(req.params.id), String(req.params.shareId), actor(req))));
router.get("/campaigns/:id/export", async (req, res) => {
  try {
    const { buffer, fileName } = await exportReportXlsx(String(req.params.id));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(buffer);
  } catch (err) {
    const status = err instanceof TestGameError ? err.status : 500;
    if (status === 500) console.error("[testgame-admin] export", err);
    res.status(status).json({ success: false, error: err instanceof TestGameError ? err.message : "Không xuất được Excel" });
  }
});

router.get("/testers/:email/schedule", (req, res) => handle(res, () => testerSchedule(String(req.params.email))));
router.patch("/testers/:userId/type", (req: AuthedRequest, res) =>
  handle(res, async () => {
    const type = req.body?.testerType ? String(req.body.testerType) : null;
    if (type && !TESTER_TYPES.some((t) => t.key === type)) throw new TestGameError("Loại tester không hợp lệ");
    const r = await prismaApp.testerProfile.updateMany({ where: { userId: String(req.params.userId) }, data: { testerType: type } });
    if (r.count === 0) throw new TestGameError("Tester chưa có hồ sơ", 404);
    return { userId: String(req.params.userId), testerType: type };
  }),
);

export default router;
