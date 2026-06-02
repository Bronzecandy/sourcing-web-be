import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth";
import {
  appendLibraryEntry,
  appendStudioTierEntry,
  deletePending,
  getLibraryJson,
  isLibraryFileId,
  listLibraryFiles,
  listPending,
  putLibraryJson,
  resolvePending,
  mergePendingIntoLibrary,
} from "../services/libraries.service";
import type { MergePendingBody } from "../services/pending-merge-apply";

const router = Router();

router.get("/files", (_req, res) => {
  try {
    res.json({ success: true, data: listLibraryFiles() });
  } catch (err) {
    console.error("[libraries] list files:", err);
    res.status(500).json({ success: false, error: "Failed to list library files" });
  }
});

router.get("/pending", async (_req, res) => {
  try {
    const data = await listPending();
    res.json({ success: true, data });
  } catch (err) {
    console.error("[libraries] list pending:", err);
    res.status(500).json({ success: false, error: "Failed to list pending" });
  }
});

router.post("/pending/:id/merge", async (req: AuthedRequest, res) => {
  try {
    const id = String(req.params.id ?? "");
    await mergePendingIntoLibrary(id, (req.body ?? {}) as MergePendingBody, req.authUser?.id);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Merge failed";
    console.error("[libraries] merge pending:", err);
    res.status(400).json({ success: false, error: msg });
  }
});

router.post("/pending/:id/resolve", async (req, res) => {
  try {
    const id = String(req.params.id ?? "");
    const ok = await resolvePending(id);
    if (!ok) return res.status(404).json({ success: false, error: "Pending id not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("[libraries] resolve pending:", err);
    res.status(500).json({ success: false, error: "Failed to resolve pending" });
  }
});

router.delete("/pending/:id", async (req, res) => {
  try {
    const id = String(req.params.id ?? "");
    const ok = await deletePending(id);
    if (!ok) return res.status(404).json({ success: false, error: "Pending id not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("[libraries] delete pending:", err);
    res.status(500).json({ success: false, error: "Failed to delete pending" });
  }
});

router.post("/studio", async (req: AuthedRequest, res) => {
  try {
    const names = req.body?.names;
    const score = req.body?.score;
    const tier = req.body?.tier;
    if (!Array.isArray(names) || typeof score !== "number") {
      return res.status(400).json({ success: false, error: "Body requires names: string[] and score: number" });
    }
    await appendStudioTierEntry({
      names: names.map(String),
      score,
      tier: typeof tier === "string" ? tier : undefined,
    });
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to append studio";
    console.error("[libraries] append studio:", err);
    res.status(400).json({ success: false, error: msg });
  }
});

router.post("/:id/entries", async (req: AuthedRequest, res) => {
  try {
    const id = String(req.params.id ?? "");
    if (!isLibraryFileId(id)) {
      return res.status(400).json({ success: false, error: "Unknown library id" });
    }
    await appendLibraryEntry(id, (req.body ?? {}) as Record<string, unknown>, req.authUser?.id);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to append entry";
    console.error("[libraries] append entry:", err);
    res.status(400).json({ success: false, error: msg });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = String(req.params.id ?? "");
    if (!isLibraryFileId(id)) {
      return res.status(400).json({ success: false, error: "Unknown library id" });
    }
    const data = await getLibraryJson(id);
    res.json({ success: true, data });
  } catch (err) {
    console.error("[libraries] get:", err);
    res.status(500).json({ success: false, error: "Failed to read library" });
  }
});

router.put("/:id", async (req: AuthedRequest, res) => {
  try {
    const id = String(req.params.id ?? "");
    if (!isLibraryFileId(id)) {
      return res.status(400).json({ success: false, error: "Unknown library id" });
    }
    await putLibraryJson(id, req.body, req.authUser?.id);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to write library";
    console.error("[libraries] put:", err);
    res.status(400).json({ success: false, error: msg });
  }
});

export default router;
