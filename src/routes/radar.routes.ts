import { Router } from "express";
import { getRadarRecap, radarFile } from "../services/radar-recap.service";

const router = Router();

router.get("/latest", async (_req, res) => {
  try {
    const data = await getRadarRecap();
    res.json({ success: true, data });
  } catch (err) {
    console.error("[radar] latest:", err);
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
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
