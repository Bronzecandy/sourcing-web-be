import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { getActiveSurvey, SurveyValidationError } from "../services/tester-survey.service";
import { getTesterMe, myBenefits, myTests, submitTesterSurvey } from "../services/tester.service";

const router = Router();

router.use(requireAuth);

router.get("/me", async (req: AuthedRequest, res) => {
  try {
    res.json({ success: true, data: await getTesterMe(req.authUser!) });
  } catch (err) {
    console.error("[tester] me:", err);
    res.status(500).json({ success: false, error: "Không tải được hồ sơ tester" });
  }
});

router.get("/survey", async (_req, res) => {
  try {
    res.json({ success: true, data: await getActiveSurvey() });
  } catch (err) {
    console.error("[tester] survey:", err);
    res.status(500).json({ success: false, error: "Không tải được bảng hỏi" });
  }
});

router.post("/survey", async (req: AuthedRequest, res) => {
  try {
    res.json({ success: true, data: await submitTesterSurvey(req.authUser!, req.body ?? {}) });
  } catch (err) {
    if (err instanceof SurveyValidationError) {
      res.status(400).json({ success: false, error: "Bảng hỏi chưa hợp lệ", issues: err.issues });
      return;
    }
    console.error("[tester] submit survey:", err);
    res.status(500).json({ success: false, error: "Không lưu được bảng hỏi" });
  }
});

router.get("/tests", async (req: AuthedRequest, res) => {
  try {
    res.json({ success: true, data: await myTests(req.authUser!.id) });
  } catch (err) {
    console.error("[tester] tests:", err);
    res.status(500).json({ success: false, error: "Không tải được danh sách test" });
  }
});

router.get("/benefits", async (req: AuthedRequest, res) => {
  try {
    res.json({ success: true, data: await myBenefits(req.authUser!.id) });
  } catch (err) {
    console.error("[tester] benefits:", err);
    res.status(500).json({ success: false, error: "Không tải được benefit" });
  }
});

export default router;
