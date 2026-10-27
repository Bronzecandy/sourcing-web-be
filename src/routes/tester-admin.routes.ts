import { Router, type Response } from "express";
import type { AuthedRequest } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import {
  TesterAdminError,
  addRedemption,
  adminMeta,
  assignTesters,
  campaignDetail,
  createCampaign,
  deleteCampaign,
  deleteRedemption,
  exportTesterWorkbook,
  listCampaigns,
  listTesters,
  recommendTesters,
  removeAssignment,
  rescoreTester,
  surveyReport,
  testerDetail,
  updateAssignment,
  updateCampaign,
  updateTester,
} from "../services/tester-admin.service";

/** /api/tester/admin — apiPermissionGuard đã chặn theo quyền tester.manage. */
const router = Router();

router.use(requireAuth);

function handle(res: Response, fn: () => Promise<unknown> | unknown): void {
  Promise.resolve()
    .then(fn)
    .then((data) => res.json({ success: true, data }))
    .catch((err) => {
      if (err instanceof TesterAdminError) {
        res.status(err.status).json({ success: false, error: err.message });
        return;
      }
      if ((err as { code?: string }).code === "P2025") {
        res.status(404).json({ success: false, error: "Không tìm thấy bản ghi" });
        return;
      }
      console.error("[tester-admin]", err);
      res.status(500).json({ success: false, error: "Lỗi Tester Program" });
    });
}

router.get("/meta", (_req, res) => handle(res, () => adminMeta()));

router.get("/testers", (_req, res) => handle(res, () => listTesters()));
router.get("/testers/:userId", (req, res) => handle(res, () => testerDetail(req.params.userId)));
router.patch("/testers/:userId", (req, res) => handle(res, () => updateTester(req.params.userId, req.body ?? {})));
router.post("/testers/:userId/rescore", (req, res) => handle(res, () => rescoreTester(req.params.userId)));

router.get("/campaigns", (_req, res) => handle(res, () => listCampaigns()));
router.post("/campaigns", (req: AuthedRequest, res) => handle(res, () => createCampaign(req.body ?? {}, req.authUser!.email)));
router.get("/campaigns/:id", (req, res) => handle(res, () => campaignDetail(req.params.id)));
router.patch("/campaigns/:id", (req, res) => handle(res, () => updateCampaign(req.params.id, req.body ?? {})));
router.delete("/campaigns/:id", (req, res) => handle(res, () => deleteCampaign(req.params.id)));
router.get("/campaigns/:id/recommend", (req, res) =>
  handle(res, () =>
    recommendTesters(req.params.id, {
      limit: Number(req.query.limit) || 7,
      platformFilter: req.query.platform !== "0",
    }),
  ),
);
router.post("/campaigns/:id/assignments", (req, res) =>
  handle(res, () => assignTesters(req.params.id, (req.body as { userIds?: unknown } | undefined)?.userIds)),
);

router.patch("/assignments/:id", (req, res) => handle(res, () => updateAssignment(req.params.id, req.body ?? {})));
router.delete("/assignments/:id", (req, res) => handle(res, () => removeAssignment(req.params.id)));

router.post("/benefits", (req: AuthedRequest, res) => handle(res, () => addRedemption(req.body ?? {}, req.authUser!.email)));
router.delete("/benefits/:id", (req, res) => handle(res, () => deleteRedemption(req.params.id)));

router.get("/survey", (_req, res) => handle(res, () => surveyReport()));

router.get("/export", async (_req, res) => {
  try {
    const body = await exportTesterWorkbook();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Tester Program ${stamp}.xlsx"`);
    res.send(body);
  } catch (err) {
    console.error("[tester-admin] export:", err);
    res.status(500).json({ success: false, error: "Xuất file thất bại" });
  }
});

export default router;
