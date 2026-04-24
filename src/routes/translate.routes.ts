import { Router } from "express";
import crypto from "crypto";
import { translateVietnameseToEnglish } from "../utils/translator";

const router = Router();

const MAX_ITEMS = 80;
const MAX_CHARS = 6000;

router.post("/strings", async (req, res) => {
  try {
    const texts = req.body?.texts;
    if (!Array.isArray(texts)) {
      res.status(400).json({ success: false, error: "Expected { texts: string[] }" });
      return;
    }
    if (texts.length > MAX_ITEMS) {
      res.status(400).json({ success: false, error: `At most ${MAX_ITEMS} strings` });
      return;
    }

    const out: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const raw = texts[i];
      const s = typeof raw === "string" ? raw : String(raw ?? "");
      if (s.length > MAX_CHARS) {
        res.status(400).json({ success: false, error: `String at index ${i} exceeds ${MAX_CHARS} chars` });
        return;
      }
      const trimmed = s.trim();
      if (!trimmed) {
        out.push("");
        continue;
      }
      const hash = crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
      const translated = await translateVietnameseToEnglish(trimmed, `bulk:${hash}`);
      out.push(translated ?? trimmed);
    }

    res.json({ success: true, data: out });
  } catch (err) {
    console.error("[translate route] POST /strings:", err);
    res.status(500).json({ success: false, error: "Translation failed" });
  }
});

export default router;
