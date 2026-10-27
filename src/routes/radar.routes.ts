import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth";
import { requirePanelAdmin } from "../middleware/auth";
import { getRadarRecap, listRadarRuns, radarFile, runRadarRecap } from "../services/radar-recap.service";
import { logDiagError } from "../utils/process-diagnostics";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
let manualRun: Promise<unknown> | null = null;

router.get("/latest", async (_req, res) => {
  try {
    const data = await getRadarRecap();
    res.json({ success: true, data });
  } catch (err) {
    console.error("[radar] latest:", err);
    res.status(503).json({ success: false, error: err instanceof Error ? err.message : "Radar unavailable" });
  }
});

router.get("/runs", async (_req, res) => {
  try {
    res.json({ success: true, data: await listRadarRuns() });
  } catch (err) {
    res.status(503).json({ success: false, error: err instanceof Error ? err.message : "Radar unavailable" });
  }
});

/** Chạy kỳ Radar ngay (nền) — chỉ panel admin. */
router.post("/run", requirePanelAdmin, (req: AuthedRequest, res) => {
  if (manualRun) {
    res.status(409).json({ success: false, error: "Radar đang chạy, thử lại sau" });
    return;
  }
  const body = (req.body ?? {}) as { date?: string; publish?: boolean };
  const date = typeof body.date === "string" && DATE_RE.test(body.date) ? body.date : undefined;
  manualRun = runRadarRecap({ force: true, date, publish: body.publish !== false })
    .catch((err) => logDiagError("radar-manual-run", err, { date: date ?? "today" }))
    .finally(() => {
      manualRun = null;
    });
  res.status(202).json({ success: true, data: { started: true, date: date ?? null } });
});

router.get("/:date", async (req, res) => {
  if (!DATE_RE.test(req.params.date)) {
    res.status(400).json({ success: false, error: "Ngày không hợp lệ" });
    return;
  }
  try {
    res.json({ success: true, data: await getRadarRecap(req.params.date) });
  } catch (err) {
    res.status(503).json({ success: false, error: err instanceof Error ? err.message : "Radar unavailable" });
  }
});

router.get("/:date/docx", async (req, res) => {
  await sendFile(req.params.date, "docx", res);
});

router.get("/:date/xlsx", async (req, res) => {
  await sendFile(req.params.date, "xlsx", res);
});

async function sendFile(
  date: string,
  kind: "docx" | "xlsx",
  res: import("express").Response,
): Promise<void> {
  if (!DATE_RE.test(date)) {
    res.status(400).json({ success: false, error: "Ngày không hợp lệ" });
    return;
  }
  try {
    const file = await radarFile(date, kind);
    if (!file) {
      res.status(404).json({ success: false, error: "Chưa có recap cho ngày này" });
      return;
    }
    const type =
      kind === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.send(file.body);
  } catch (err) {
    console.error(`[radar] ${kind}:`, err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : "Export failed" });
  }
}

export default router;
