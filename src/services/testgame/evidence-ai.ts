import sharp from "sharp";
import type { Prisma } from "../../../generated/prisma-app/client";
import { callLLMWithImages, getModel } from "../../utils/ai-client";
import { compassWebSearch } from "../../utils/compass-web-search";
import { prismaApp } from "../../utils/prisma-app";
import { genreLabel } from "../tester-config";
import { isoDate } from "./common";
import { absolutePath, hamming, readAsDataUrl } from "./files";
import { parseLlmJson } from "./ai-json";
import { campaignTemplate, type Answers } from "./templates";

export interface EvidenceCheck {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail";
  note: string;
}

export interface EvidenceDuplicate {
  fileId: string;
  matchFileId: string;
  kind: "exact" | "identical" | "similar";
  scope: "same_test_other_tester" | "own_old_test" | "other_test";
  email: string;
  gameName: string;
  sameScreenshot?: boolean;
}

export interface EvidenceReview {
  verdict: "approve" | "review" | "reject";
  confidence: number;
  uid: string | null;
  level: string | null;
  progress: string | null;
  claimedHours: number | null;
  claimedLevel: string | null;
  requiredHours: number;
  checks: EvidenceCheck[];
  duplicates: EvidenceDuplicate[];
  summary: string;
  research: { brief: string; sources: string[]; grounded: boolean } | null;
  model: string;
  at: string;
}

const RESEARCH_TTL_MS = 14 * 86_400_000;

interface ProgressResearch {
  hours: number;
  brief: string;
  sources: string[];
  grounded: boolean;
  at: string;
}

/** Tiến độ kỳ vọng sau N giờ chơi (web search, cache theo game test). */
async function progressResearch(c: {
  id: string;
  gameName: string;
  originalName: string | null;
  genre: string | null;
  developer: string | null;
  mainTags: string[];
  progressResearch: unknown;
}, hours: number): Promise<ProgressResearch | null> {
  const cached = c.progressResearch as ProgressResearch | null;
  if (cached && cached.hours === hours && Date.now() - Date.parse(cached.at) < RESEARCH_TTL_MS) return cached;
  const name = c.originalName ? `"${c.gameName}" (original name: "${c.originalName}")` : `"${c.gameName}"`;
  const question = `Game ${name}${c.developer ? `, developer ${c.developer}` : ""}, genre ${c.genre ?? c.mainTags.map(genreLabel).join(", ")}.
A tester plays this game (possibly a beta / test build) for about ${hours} hours in total.
From guides, wikis, beta reports, forum posts or videos: what account / character level, chapter, stage or other progress does a typical new player reach after about ${hours} hours? How fast does level rise in the first hours, and are there early-game caps or gates (story chapters, stamina, daily limits)?
Also: where does the game UI show the player UID and level (profile screen, top-left avatar...)?
If the game is too new and nothing is published, say so clearly.`;
  try {
    const r = await compassWebSearch(question, {
      sourceHint: "Use sources in any language (Chinese, Korean, Japanese, English, Vietnamese): official sites, wikis, TapTap / Bilibili / NGA / Reddit posts, guides.",
    });
    const out: ProgressResearch = { hours, brief: r.brief.slice(0, 4000), sources: r.sources.slice(0, 8), grounded: r.grounded, at: new Date().toISOString() };
    await prismaApp.testCampaign.update({ where: { id: c.id }, data: { progressResearch: out as unknown as Prisma.InputJsonValue } });
    return out;
  } catch (err) {
    console.warn("[testgame] progress research failed:", (err as Error).message);
    return null;
  }
}

async function meanAbsDiff(aPath: string, bPath: string): Promise<number> {
  const load = (p: string) => sharp(absolutePath(p)).greyscale().resize(128, 128, { fit: "fill" }).raw().toBuffer();
  const [a, b] = await Promise.all([load(aPath), load(bPath)]);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Ảnh trùng: sha256 giống hệt; dHash gần (≤ 10) rồi so điểm ảnh 128×128 để tách "cùng ảnh" và "cùng màn hình". */
async function findDuplicates(assignmentId: string, email: string, files: Array<{ id: string; sha256: string; dhash: string | null; storagePath: string }>) {
  const others = await prismaApp.testFile.findMany({
    where: { kind: "evidence", OR: [{ assignmentId: { not: assignmentId } }, { assignmentId: null }] },
    select: {
      id: true,
      sha256: true,
      dhash: true,
      storagePath: true,
      campaignId: true,
      assignment: { select: { email: true, campaignId: true } },
      campaign: { select: { gameName: true } },
    },
  });
  const mine = await prismaApp.testAssignment.findUnique({ where: { id: assignmentId }, select: { campaignId: true } });
  const out: Array<EvidenceDuplicate & { matchPath: string }> = [];
  for (const f of files) {
    for (const o of others) {
      let kind: EvidenceDuplicate["kind"] | null = null;
      if (o.sha256 === f.sha256) kind = "exact";
      else if (f.dhash && o.dhash && hamming(f.dhash, o.dhash) <= 10) {
        try {
          kind = (await meanAbsDiff(f.storagePath, o.storagePath)) <= 2 ? "identical" : "similar";
        } catch {
          kind = "similar";
        }
      }
      if (!kind) continue;
      const otherEmail = o.assignment?.email ?? "";
      const scope: EvidenceDuplicate["scope"] =
        o.campaignId === mine?.campaignId ? "same_test_other_tester" : otherEmail === email ? "own_old_test" : "other_test";
      out.push({ fileId: f.id, matchFileId: o.id, kind, scope, email: otherEmail, gameName: o.campaign.gameName, matchPath: o.storagePath });
    }
  }
  const rank = { exact: 0, identical: 1, similar: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 8);
}

const SYSTEM = `You verify whether a game tester really played a test build of a game.
You look at the tester's evidence screenshots, read what is visible (UID, level, chapter, stage, playtime...) and compare it with the tester's claims and with what is known about the game's progression.
Be fair: test builds often have little public information; when you cannot verify something, answer "unclear" instead of failing the tester.
Never invent text that is not visible in the screenshots. Write every note and the summary in Vietnamese.`;

interface VisionOutput {
  game_match?: string;
  game_match_note?: string;
  uid?: string | null;
  level?: string | null;
  progress?: string | null;
  claim_check?: string;
  claim_note?: string;
  progress_vs_hours?: string;
  progress_note?: string;
  duplicate_check?: string;
  duplicate_note?: string;
  tampering?: string;
  tampering_note?: string;
  verdict?: string;
  confidence?: number;
  summary?: string;
}

function answerOf(answers: Answers, questions: Array<{ id: string; key?: string | null }>, key: string): string | number | null {
  const q = questions.find((x) => x.key === key);
  const v = q ? answers[q.id] : null;
  return typeof v === "string" || typeof v === "number" ? v : null;
}

const running = new Set<string>();
const pending: string[] = [];
let active = 0;

/** Xếp hàng chấm bằng chứng (tối đa 2 lượt song song). */
export function queueEvidenceReview(assignmentId: string): void {
  if (running.has(assignmentId) || pending.includes(assignmentId)) return;
  pending.push(assignmentId);
  void prismaApp.testAssignment.update({ where: { id: assignmentId }, data: { aiStatus: "queued" } }).catch(() => undefined);
  pump();
}

function pump(): void {
  while (active < 2 && pending.length > 0) {
    const id = pending.shift()!;
    active++;
    running.add(id);
    reviewEvidence(id)
      .catch(async (err) => {
        console.error("[testgame] evidence review", id, err);
        await prismaApp.testAssignment
          .update({ where: { id }, data: { aiStatus: "failed", aiReview: { error: String((err as Error).message).slice(0, 300) } } })
          .catch(() => undefined);
      })
      .finally(() => {
        active--;
        running.delete(id);
        pump();
      });
  }
}

const LABEL: Record<string, string> = {
  game_match: "Đúng game",
  uid: "Thấy UID",
  progress: "Thấy level / tiến trình",
  claim: "Khớp khai báo",
  hours: "Tiến độ so với giờ test",
  duplicate: "Ảnh không trùng",
  uid_reuse: "UID không trùng tester khác",
  tampering: "Không có dấu hiệu chỉnh sửa",
};

export async function reviewEvidence(assignmentId: string): Promise<EvidenceReview> {
  await prismaApp.testAssignment.update({ where: { id: assignmentId }, data: { aiStatus: "running" } });
  const a = await prismaApp.testAssignment.findUniqueOrThrow({
    where: { id: assignmentId },
    include: { campaign: true, files: { where: { kind: "evidence" }, orderBy: { createdAt: "asc" } } },
  });
  const c = a.campaign;
  const tpl = await campaignTemplate(c);
  const answers = (a.answers ?? {}) as Answers;
  const questions = tpl?.questions ?? [];
  const claimedHoursRaw = answerOf(answers, questions, "play_hours");
  const claimedHours = claimedHoursRaw == null ? null : Number(claimedHoursRaw);
  const claimedLevel = answerOf(answers, questions, "level");
  const requiredHours = a.workloadHours ?? c.workloadHours;
  const files = a.files.slice(0, 3);

  const checks: EvidenceCheck[] = [];
  if (files.length === 0) {
    const review: EvidenceReview = {
      verdict: "review",
      confidence: 0,
      uid: null,
      level: null,
      progress: null,
      claimedHours,
      claimedLevel: claimedLevel == null ? null : String(claimedLevel),
      requiredHours,
      checks: [{ key: "evidence", label: "Có ảnh bằng chứng", status: "fail", note: "Tester chưa nộp ảnh bằng chứng." }],
      duplicates: [],
      summary: "Chưa có ảnh bằng chứng — Admin kiểm tra thủ công hoặc yêu cầu tester bổ sung.",
      research: null,
      model: "-",
      at: new Date().toISOString(),
    };
    await save(assignmentId, review);
    return review;
  }

  const [duplicates, research, peers] = await Promise.all([
    findDuplicates(a.id, a.email, files),
    progressResearch(c, requiredHours),
    prismaApp.testAssignment.findMany({ where: { campaignId: c.id, id: { not: a.id }, aiStatus: "done" }, select: { email: true, aiReview: true } }),
  ]);
  const peerUids = peers
    .map((p) => ({ email: p.email, uid: (p.aiReview as { uid?: string | null } | null)?.uid ?? null }))
    .filter((p): p is { email: string; uid: string } => Boolean(p.uid));

  const similar = duplicates.filter((d) => d.kind === "similar").slice(0, 2);
  const images = [
    ...files.map((f, i) => ({ url: readAsDataUrl(f.storagePath, f.mime), label: `Evidence ${i + 1} (this tester):` })),
    ...similar.map((d, i) => ({
      url: readAsDataUrl(d.matchPath, "image/jpeg"),
      label: `Comparison ${i + 1}: a visually similar screenshot submitted earlier by ${d.scope === "own_old_test" ? "the same tester in another test" : "another tester"} (game: ${d.gameName}). Compare it with Evidence image(s): is it the same screenshot (same UID / same numbers), or just the same screen of a different account?`,
    })),
  ];

  const prompt = `Game: ${c.gameName}${c.originalName ? ` (original name: ${c.originalName})` : ""}
Genre: ${c.genre ?? "-"} · Main genre lines: ${c.mainTags.map(genreLabel).join(", ") || "-"} · Platforms: ${c.platforms.join(", ") || "-"} · Developer: ${c.developer ?? "-"}
Test window: ${isoDate(c.startDate) ?? "?"} → ${isoDate(c.endDate) ?? "?"} · Required play time: about ${requiredHours} hours (format: ${c.evalFormat ?? "-"})
Tester claims: played ${claimedHours ?? "?"} hours, level / progress "${claimedLevel ?? "?"}"; submitted ${a.submittedAt?.toISOString().slice(0, 10) ?? "?"}
Other testers' UIDs already seen in this test: ${peerUids.map((p) => p.uid).join(", ") || "none"}

Web research on progression (may be empty or about a different build):
${research?.brief ? research.brief.slice(0, 2500) : "No public information found."}

Exact / near-identical duplicates already detected by the system: ${
    duplicates.filter((d) => d.kind !== "similar").map((d) => `${d.kind} match with ${d.scope} (${d.gameName})`).join("; ") || "none"
  }

Task: check the evidence and answer ONLY this JSON:
{
  "game_match": "yes | no | unclear",
  "game_match_note": "",
  "uid": "UID exactly as visible, or null",
  "level": "level / rank exactly as visible, or null",
  "progress": "other visible progress (chapter, stage, playtime, power...), or null",
  "claim_check": "consistent | inconsistent | unclear",
  "claim_note": "",
  "progress_vs_hours": "plausible | too_low | too_high | unclear",
  "progress_note": "",
  "duplicate_check": "none | same_screenshot | different_account",
  "duplicate_note": "",
  "tampering": "none | suspected",
  "tampering_note": "",
  "verdict": "approve | review | reject",
  "confidence": 0-100,
  "summary": "1–3 Vietnamese sentences for the admin"
}
Verdict rules:
- approve: screenshots are from this game, a UID and a level / progress are visible, they match the claim, progress is plausible for ~${requiredHours} hours (or unclear only because nothing is published), no duplicate, no editing signs.
- reject: screenshots are not from this game, the same screenshot as another tester / an older test, obvious editing, or progress clearly far too low for ~${requiredHours} hours (e.g. still in the tutorial).
- review: everything else that is uncertain (missing UID, blurry, claim mismatch, no comparison data).
- duplicate_check is "none" when there is no Comparison image.`;

  const res = await callLLMWithImages(SYSTEM, prompt, images, 6000);
  const out = parseLlmJson<VisionOutput>(res.content);

  const st = (v: string | undefined, good: string[], bad: string[]): EvidenceCheck["status"] =>
    v && good.includes(v) ? "pass" : v && bad.includes(v) ? "fail" : "warn";
  checks.push({ key: "game_match", label: LABEL.game_match, status: st(out.game_match, ["yes"], ["no"]), note: out.game_match_note ?? "" });
  checks.push({ key: "uid", label: LABEL.uid, status: out.uid ? "pass" : "warn", note: out.uid ? `UID ${out.uid}` : "Không đọc được UID" });
  checks.push({
    key: "progress",
    label: LABEL.progress,
    status: out.level || out.progress ? "pass" : "warn",
    note: [out.level && `Level ${out.level}`, out.progress].filter(Boolean).join(" · ") || "Không thấy level / tiến trình",
  });
  checks.push({ key: "claim", label: LABEL.claim, status: st(out.claim_check, ["consistent"], ["inconsistent"]), note: out.claim_note ?? "" });
  checks.push({ key: "hours", label: LABEL.hours, status: st(out.progress_vs_hours, ["plausible"], ["too_low"]), note: out.progress_note ?? "" });

  const marked = duplicates.map(({ matchPath: _p, ...d }) => ({
    ...d,
    ...(d.kind === "similar" ? { sameScreenshot: out.duplicate_check === "same_screenshot" } : {}),
  }));
  const hardDup = marked.filter((d) => d.kind !== "similar" || d.sameScreenshot);
  checks.push({
    key: "duplicate",
    label: LABEL.duplicate,
    status: hardDup.length > 0 ? "fail" : "pass",
    note:
      hardDup.length > 0
        ? hardDup
            .map((d) =>
              d.scope === "same_test_other_tester"
                ? `Trùng ảnh của ${d.email} trong game test này`
                : d.scope === "own_old_test"
                  ? `Ảnh cũ của chính tester (game ${d.gameName})`
                  : `Trùng ảnh đã nộp ở game test ${d.gameName}`,
            )
            .join("; ")
        : marked.length > 0
          ? `Có ${marked.length} ảnh cùng màn hình nhưng khác tài khoản${out.duplicate_note ? ` — ${out.duplicate_note}` : ""}`
          : "Không trùng ảnh đã nộp",
  });
  const uid = out.uid ? String(out.uid).trim() : null;
  const reused = uid ? peerUids.filter((p) => p.uid.replace(/\s/g, "") === uid.replace(/\s/g, "")) : [];
  checks.push({
    key: "uid_reuse",
    label: LABEL.uid_reuse,
    status: reused.length > 0 ? "fail" : uid ? "pass" : "warn",
    note: reused.length > 0 ? `Cùng UID với ${reused.map((r) => r.email).join(", ")}` : uid ? "UID chưa xuất hiện ở tester khác" : "Không có UID để so",
  });
  checks.push({ key: "tampering", label: LABEL.tampering, status: out.tampering === "suspected" ? "fail" : "pass", note: out.tampering_note ?? "" });

  let verdict = (["approve", "review", "reject"].includes(String(out.verdict)) ? out.verdict : "review") as EvidenceReview["verdict"];
  if (hardDup.some((d) => d.scope !== "own_old_test" || d.kind === "exact")) verdict = "reject";
  else if (reused.length > 0 && verdict === "approve") verdict = "review";
  else if (hardDup.length > 0 && verdict === "approve") verdict = "review";

  const review: EvidenceReview = {
    verdict,
    confidence: Math.max(0, Math.min(100, Math.round(Number(out.confidence) || 0))),
    uid,
    level: out.level ? String(out.level) : null,
    progress: out.progress ? String(out.progress) : null,
    claimedHours,
    claimedLevel: claimedLevel == null ? null : String(claimedLevel),
    requiredHours,
    checks,
    duplicates: marked,
    summary: String(out.summary ?? "").slice(0, 800),
    research: research ? { brief: research.brief.slice(0, 1500), sources: research.sources, grounded: research.grounded } : null,
    model: res.model || getModel(),
    at: new Date().toISOString(),
  };
  await save(assignmentId, review);
  return review;
}

async function save(id: string, review: EvidenceReview): Promise<void> {
  await prismaApp.testAssignment.update({
    where: { id },
    data: { aiStatus: "done", aiReview: review as unknown as Prisma.InputJsonValue, aiReviewAt: new Date() },
  });
}
