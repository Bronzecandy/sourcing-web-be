import { Router } from "express";
import { distributionService } from "../services/distribution.service";
import { beginPrecomputePause, endPrecomputePause } from "../utils/analysis-active-guard";
import type { DistributionLifecycleFilter, DistributionMetric, DistributionTab } from "../types";

const router = Router();

const METRICS = new Set<DistributionMetric>([
  "reserve",
  "download",
  "rating",
  "reviewCount",
  "fans",
]);

const LIFECYCLES = new Set<DistributionLifecycleFilter>([
  "all",
  "reserve",
  "new",
  "old",
  "unknown",
]);

const TABS = new Set<DistributionTab>(["reserve", "new", "old"]);

router.get("/distribution/meta", async (_req, res) => {
  const data = await distributionService.getMeta();
  res.json({ success: true, data });
});

function parseOverviewQuery(req: import("express").Request) {
  const yearRaw = String(req.query.year ?? "").trim();
  const year =
    yearRaw === "" || yearRaw === "all"
      ? null
      : parseInt(yearRaw, 10);
  const monthRaw = req.query.month;
  const month =
    monthRaw != null && String(monthRaw).trim() !== ""
      ? parseInt(String(monthRaw), 10)
      : undefined;
  const lifecycle = String(req.query.lifecycle ?? "reserve") as DistributionTab;
  return { year, month, lifecycle };
}

router.get("/distribution/overview/trends", async (req, res) => {
  const pauseLabel = "distribution-trends";
  beginPrecomputePause(pauseLabel);
  try {
    const { year, month, lifecycle } = parseOverviewQuery(req);

    if (year != null && (!Number.isFinite(year) || year < 2000 || year > 2100)) {
      res.status(400).json({ success: false, error: "year must be 2000–2100 or all" });
      return;
    }
    if (month != null && (!Number.isFinite(month) || month < 1 || month > 12)) {
      res.status(400).json({ success: false, error: "month must be 1–12" });
      return;
    }
    if (!TABS.has(lifecycle)) {
      res.status(400).json({ success: false, error: "lifecycle must be reserve, new, or old" });
      return;
    }

    const data = await distributionService.getTrends({ year, month, lifecycle });
    res.json({ success: true, data });
  } finally {
    endPrecomputePause(pauseLabel);
  }
});

router.get("/distribution/overview", async (req, res) => {
  const pauseLabel = "distribution-overview";
  beginPrecomputePause(pauseLabel);
  try {
  const { year, month, lifecycle } = parseOverviewQuery(req);

  if (year != null && (!Number.isFinite(year) || year < 2000 || year > 2100)) {
    res.status(400).json({ success: false, error: "year must be 2000–2100 or all" });
    return;
  }
  if (month != null && (!Number.isFinite(month) || month < 1 || month > 12)) {
    res.status(400).json({ success: false, error: "month must be 1–12" });
    return;
  }
  if (!TABS.has(lifecycle)) {
    res.status(400).json({ success: false, error: "lifecycle must be reserve, new, or old" });
    return;
  }

  const data = await distributionService.getOverview({ year, month, lifecycle });
  res.json({ success: true, data });
  } finally {
    endPrecomputePause(pauseLabel);
  }
});

router.get("/distribution", async (req, res) => {
  const pauseLabel = "distribution-legacy";
  beginPrecomputePause(pauseLabel);
  try {
  const year = parseInt(String(req.query.year ?? ""), 10);
  const monthRaw = req.query.month;
  const month =
    monthRaw != null && String(monthRaw).trim() !== ""
      ? parseInt(String(monthRaw), 10)
      : undefined;
  const metric = String(req.query.metric ?? "reserve") as DistributionMetric;
  const lifecycle = String(req.query.lifecycle ?? "all") as DistributionLifecycleFilter;

  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    res.status(400).json({ success: false, error: "year is required (2000–2100)" });
    return;
  }
  if (month != null && (!Number.isFinite(month) || month < 1 || month > 12)) {
    res.status(400).json({ success: false, error: "month must be 1–12" });
    return;
  }
  if (!METRICS.has(metric)) {
    res.status(400).json({ success: false, error: "invalid metric" });
    return;
  }
  if (!LIFECYCLES.has(lifecycle)) {
    res.status(400).json({ success: false, error: "invalid lifecycle" });
    return;
  }

  const data = await distributionService.getDistribution({
    year,
    month,
    metric,
    lifecycle,
  });
  res.json({ success: true, data });
  } finally {
    endPrecomputePause(pauseLabel);
  }
});

export default router;
