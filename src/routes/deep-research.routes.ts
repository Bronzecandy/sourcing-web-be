import { Router, type Response } from "express";
import type { AuthedRequest } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { MarketDataError } from "../utils/market-data";
import { DeepResearchError, saveMapping, type MappingChoice } from "../services/deep-research/mapping";
import { appOverview, candidatesFor, continueRun, frameworksDto, getRun, listRuns, startRun } from "../services/deep-research/runs";
import { marketSummary } from "../services/deep-research/summary";
import type { RunContext } from "../services/deep-research/types";

/** /api/deep-research — apiPermissionGuard requires analytics.potential. */
const router = Router();
router.use(requireAuth);

function handle(res: Response, fn: () => Promise<unknown> | unknown): void {
  Promise.resolve()
    .then(fn)
    .then((data) => res.json({ success: true, data }))
    .catch((err) => {
      if (err instanceof DeepResearchError) {
        res.status(err.status).json({ success: false, error: err.message });
        return;
      }
      if (err instanceof MarketDataError) {
        console.error("[deep-research] market-data:", err.message);
        res.status(err.status === 503 ? 503 : 502).json({ success: false, error: `Không đọc được dữ liệu Sensor Tower/Steam: ${err.message}` });
        return;
      }
      console.error("[deep-research]", err);
      res.status(500).json({ success: false, error: "Lỗi module Deep Research" });
    });
}

function appIdParam(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new DeepResearchError("appId không hợp lệ");
  return id;
}

function parseContext(body: Record<string, unknown>): RunContext | null {
  const days = Number(body.days);
  const platform = body.platform;
  const segment = body.segment;
  if (![7, 14, 30].includes(days)) return null;
  if (platform !== "combined" && platform !== "android" && platform !== "ios") return null;
  if (segment !== "reserve" && segment !== "launched") return null;
  return { days, platform, segment };
}

function parseChoice(body: Record<string, unknown>): MappingChoice {
  const choice: MappingChoice = {};
  const st = body.st as Record<string, unknown> | undefined;
  if (st && typeof st === "object") {
    if (typeof st.unifiedId === "string") choice.st = { unifiedId: st.unifiedId };
    else if (st.none === true) choice.st = { none: true };
    else if (st.reset === true) choice.st = { reset: true };
  }
  const steam = body.steam as Record<string, unknown> | undefined;
  if (steam && typeof steam === "object") {
    if (steam.steamAppId != null) choice.steam = { steamAppId: Number(steam.steamAppId) };
    else if (steam.none === true) choice.steam = { none: true };
    else if (steam.reset === true) choice.steam = { reset: true };
  }
  if (!choice.st && !choice.steam) throw new DeepResearchError("Thiếu lựa chọn mapping (st hoặc steam)");
  return choice;
}

router.get("/frameworks", (_req, res) => handle(res, () => frameworksDto()));

router.post("/market-summary", (req, res) =>
  handle(res, () => {
    const appIds = Array.isArray(req.body?.appIds) ? (req.body.appIds as unknown[]).map(Number) : [];
    return marketSummary(appIds);
  }),
);

router.get("/runs", (req, res) => handle(res, () => listRuns(Number(req.query.limit ?? 50) || 50)));
router.get("/runs/:id", (req, res) => handle(res, () => getRun(String(req.params.id))));
router.post("/runs/:id/continue", (req, res) => handle(res, () => continueRun(String(req.params.id))));

router.get("/apps/:appId", (req, res) => handle(res, () => appOverview(appIdParam(req.params.appId))));
router.post("/apps/:appId/runs", (req: AuthedRequest, res) =>
  handle(res, () => {
    const user = req.authUser!;
    return startRun(appIdParam(req.params.appId), parseContext(req.body ?? {}), { id: user.id, name: user.name, email: user.email });
  }),
);
router.get("/apps/:appId/candidates", (req, res) =>
  handle(res, () => candidatesFor(appIdParam(req.params.appId), typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null)),
);
router.put("/apps/:appId/mapping", (req: AuthedRequest, res) =>
  handle(res, () => saveMapping(appIdParam(req.params.appId), parseChoice(req.body ?? {}), req.authUser!.email)),
);

export default router;
