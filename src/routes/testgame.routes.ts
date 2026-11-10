import crypto from "crypto";
import path from "path";
import { Router } from "express";
import multer from "multer";
import type { AuthedRequest } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { hasPermission } from "../utils/permissions";
import { prismaApp } from "../utils/prisma-app";
import { absolutePath, uploadTmpDir } from "../services/testgame/files";
import { resolveShareKey, sharedReport } from "../services/testgame/report";
import {
  deleteTesterFile,
  fileAccess,
  myTestGame,
  myTestGames,
  respondInvite,
  saveSurvey,
  surveyForm,
  uploadTesterFile,
} from "../services/testgame/tester-flow";
import { testGameHandle as handle } from "./testgame-admin.routes";

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadTmpDir()),
    filename: (_req, file, cb) => cb(null, `${crypto.randomBytes(8).toString("hex")}${path.extname(file.originalname).slice(0, 10)}`),
  }),
  limits: { fileSize: 1024 * 1024 * 1024, files: 1 },
});

function sendStored(res: import("express").Response, f: { mime: string; fileName: string; storagePath: string }, download: boolean) {
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(absolutePath(f.storagePath), (err) => {
    if (err && !res.headersSent) res.status(404).json({ success: false, error: "Tệp không còn trên máy chủ" });
  });
}

/** /api/testgame/share — người có key xem report (chỉ đọc), không cần đăng nhập. */
export const testGameShareRouter = Router();
testGameShareRouter.get("/:key", (req, res) => handle(res, () => sharedReport(String(req.params.key))));
testGameShareRouter.get("/:key/files/:fileId", async (req, res) => {
  try {
    const campaignId = await resolveShareKey(String(req.params.key));
    const f = await prismaApp.testFile.findUnique({ where: { id: String(req.params.fileId) } });
    if (!f || f.campaignId !== campaignId || f.kind !== "footage") {
      res.status(404).json({ success: false, error: "Không tìm thấy tệp" });
      return;
    }
    sendStored(res, f, Boolean(req.query.download));
  } catch {
    res.status(404).json({ success: false, error: "Link chia sẻ không còn hiệu lực" });
  }
});

/** /api/testgame — tester (đăng nhập) phản hồi lời mời, làm questionnaire, nộp bằng chứng. */
const router = Router();
router.use(requireAuth);

router.get("/tests", (req: AuthedRequest, res) => handle(res, () => myTestGames(req.authUser!)));
router.get("/tests/:id", (req: AuthedRequest, res) => handle(res, () => myTestGame(req.authUser!, String(req.params.id))));
router.post("/tests/:id/respond", (req: AuthedRequest, res) => handle(res, () => respondInvite(req.authUser!, String(req.params.id), req.body ?? {})));
router.get("/tests/:id/survey", (req: AuthedRequest, res) => handle(res, () => surveyForm(req.authUser!, String(req.params.id))));
router.post("/tests/:id/survey", (req: AuthedRequest, res) => handle(res, () => saveSurvey(req.authUser!, String(req.params.id), req.body ?? {})));
router.post("/tests/:id/files", upload.single("file"), (req: AuthedRequest, res) =>
  handle(res, () => uploadTesterFile(req.authUser!, String(req.params.id), String(req.query.kind ?? ""), req.file)),
);
router.delete("/files/:fileId", (req: AuthedRequest, res) => handle(res, () => deleteTesterFile(req.authUser!, String(req.params.fileId))));
router.get("/files/:fileId", async (req: AuthedRequest, res) => {
  try {
    const user = req.authUser!;
    const f = await fileAccess(user, String(req.params.fileId), user.status === "ACTIVE" && hasPermission(user, "tester.manage"));
    sendStored(res, f, Boolean(req.query.download));
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ success: false, error: (err as Error).message });
  }
});

export default router;
