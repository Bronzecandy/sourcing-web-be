import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth";
import { attachAuth, requireAuth } from "../middleware/auth";
import {
  getGoogleAuthUrl,
  handleGoogleCallback,
  createSessionToken,
  setAuthCookie,
  clearAuthCookie,
  redirectAfterLogin,
  parseLoginPortal,
  frontendUrl,
} from "../services/auth.service";

const router = Router();

router.get("/google", (req, res) => {
  try {
    res.redirect(getGoogleAuthUrl(parseLoginPortal(req.query.portal)));
  } catch (err) {
    console.error("[auth] google redirect:", err);
    res.status(500).json({ success: false, error: "Google OAuth not configured" });
  }
});

router.get("/google/callback", async (req, res) => {
  const portal = parseLoginPortal(req.query.state);
  try {
    const code = String(req.query.code ?? "");
    if (!code) {
      res.status(400).json({ success: false, error: "Missing code" });
      return;
    }
    const user = await handleGoogleCallback(code, portal);
    const token = await createSessionToken(user.id);
    setAuthCookie(res, token);
    res.redirect(redirectAfterLogin(user, portal));
  } catch (err) {
    if (err instanceof Error && err.message === "TESTER_EMAIL_NOT_ALLOWED") {
      res.redirect(`${frontendUrl()}/tester/login?error=domain`);
      return;
    }
    console.error("[auth] callback:", err);
    res.status(500).json({ success: false, error: "Login failed" });
  }
});

router.get("/me", attachAuth, requireAuth, (req: AuthedRequest, res) => {
  res.json({ success: true, data: req.authUser });
});

router.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

export default router;
