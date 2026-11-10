import crypto from "crypto";
import ExcelJS from "exceljs";
import type { Prisma } from "../../../generated/prisma-app/client";
import { callLLM } from "../../utils/ai-client";
import { compassWebSearch } from "../../utils/compass-web-search";
import { prismaApp } from "../../utils/prisma-app";
import { genreLabel } from "../tester-config";
import { audit, getSettings, isoDate, publicUrl, TestGameError, todayIct } from "./common";
import { DECISIONS, labelOf, type TemplateQuestion } from "./defaults";
import { fileDto } from "./files";
import { mapLimit, parseLlmJson } from "./ai-json";
import { campaignTemplate, isVisible, type Answers, type TemplateSnapshot } from "./templates";

type SectionText = { vi: string; en: string };

interface TesterAnswerRow {
  index: number;
  assignmentId: string;
  name: string;
  email: string;
  submittedAt: string | null;
  reviewStatus: string | null;
  answers: Answers;
}

async function loadReportData(campaignId: string) {
  const c = await prismaApp.testCampaign.findUnique({
    where: { id: campaignId },
    include: {
      report: true,
      assignments: {
        include: { user: { select: { name: true, testerProfile: { select: { name: true } } } }, files: { where: { kind: "footage" } } },
        orderBy: { submittedAt: "asc" },
      },
    },
  });
  if (!c) throw new TestGameError("Không tìm thấy game test", 404);
  if (c.noTest) throw new TestGameError("Game Không test không có report", 404);
  const tpl = await campaignTemplate(c);
  const submitted = c.assignments.filter((a) => a.status === "submitted" && a.reviewStatus !== "rejected");
  const testers: TesterAnswerRow[] = submitted.map((a, i) => ({
    index: i + 1,
    assignmentId: a.id,
    name: a.user?.testerProfile?.name ?? a.user?.name ?? a.email,
    email: a.email,
    submittedAt: a.submittedAt?.toISOString() ?? null,
    reviewStatus: a.reviewStatus,
    answers: (a.answers ?? {}) as Answers,
  }));
  const report = c.report ?? (await prismaApp.testReport.create({ data: { campaignId } }));
  return { c, tpl, testers, report, invited: c.assignments.filter((a) => a.status !== "added").length };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Điểm section (mục 5.3): trung bình điểm câu Điểm; tag có câu Điều kiện chỉ tính tester trả lời Có. */
export function computeSections(tpl: TemplateSnapshot, testers: TesterAnswerRow[], saved: Record<string, SectionText>) {
  const tagOrder = [...new Set(tpl.questions.map((q) => q.tag).filter((t): t is string => Boolean(t)))];
  const sections = tagOrder.map((tag) => {
    const def = tpl.tags.find((t) => t.name === tag);
    const scoreQs = tpl.questions.filter((q) => q.tag === tag && q.role === "score");
    const reasonQs = tpl.questions.filter((q) => q.tag === tag && q.role === "reason");
    const cond = tpl.questions.find((q) => q.tag === tag && q.role === "condition");
    const scored = (def?.scored ?? true) && scoreQs.length > 0;
    const details = testers.map((t) => {
      const condYes = cond ? t.answers[cond.id] === "yes" : true;
      const scores = scoreQs.map((q) => t.answers[q.id]).filter((v): v is number => typeof v === "number");
      const reasons = reasonQs.map((q) => t.answers[q.id]).filter((v): v is string => typeof v === "string" && v.trim() !== "");
      return { tester: t.index, name: t.name, condition: cond ? (t.answers[cond.id] as string | null) : null, counted: condYes, scores, reasons };
    });
    const counted = details.filter((d) => d.counted && d.scores.length > 0);
    const all = counted.flatMap((d) => d.scores);
    const score = scored && all.length > 0 ? round1(all.reduce((s, x) => s + x, 0) / all.length) : null;
    return {
      tag,
      description: def?.description ?? "",
      scored,
      weight: scored ? tpl.tagWeights[tag] ?? 1 : null,
      score,
      answered: counted.length,
      condition: cond ? { question: cond.code, yes: details.filter((d) => d.condition === "yes").length, total: testers.length } : null,
      questions: [...(cond ? [cond] : []), ...scoreQs, ...reasonQs].map((q) => ({ code: q.code, text: q.text, role: q.role })),
      summary: saved[tag] ?? { vi: "", en: "" },
      details,
    };
  });
  const withScore = sections.filter((s) => s.scored && s.score != null);
  const wSum = withScore.reduce((s, x) => s + (x.weight ?? 1), 0);
  const overall = wSum > 0 ? round1(withScore.reduce((s, x) => s + x.score! * (x.weight ?? 1), 0) / wSum) : null;
  return { sections, overall };
}

function openAnswers(tpl: TemplateSnapshot, testers: TesterAnswerRow[], key: string): string[] {
  const qs = tpl.questions.filter((q) => q.key === key);
  return testers.flatMap((t) => qs.map((q) => t.answers[q.id]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => `Tester ${t.index}: ${v}`));
}

async function aiScreening(appId: number | null) {
  if (!appId) return null;
  const row = await prismaApp.userAiAnalysis.findFirst({ where: { appId }, orderBy: { analyzedAt: "desc" }, select: { id: true, analyzedAt: true } });
  return row ? { url: `/ai-analysis/a/${row.id}`, analyzedAt: row.analyzedAt.toISOString() } : null;
}

export function reportName(c: { gameName: string; genre: string | null }): string {
  return `[New Game] Test Result - ${c.gameName}${c.genre ? ` [${c.genre}]` : ""}`;
}

export async function getReport(campaignId: string, opts: { share?: boolean } = {}) {
  const { c, tpl, testers, report, invited } = await loadReportData(campaignId);
  const saved = (report.sections ?? {}) as Record<string, SectionText>;
  const computed = tpl ? computeSections(tpl, testers, saved) : { sections: [], overall: null };
  const footage = c.assignments.flatMap((a, i) => a.files.map((f) => ({ ...fileDto(f), tester: opts.share ? `Tester ${i + 1}` : a.user?.testerProfile?.name ?? a.email })));
  const footageLinks = tpl
    ? testers.flatMap((t) => tpl.questions.filter((q) => q.key === "footage").flatMap((q) => (Array.isArray(t.answers[q.id]) ? (t.answers[q.id] as string[]) : []).map((url) => ({ url, tester: opts.share ? `Tester ${t.index}` : t.name }))))
    : [];
  const runs = opts.share
    ? []
    : await prismaApp.testReportRun.findMany({ where: { campaignId }, orderBy: { createdAt: "desc" }, take: 15 });
  const anonymize = <T extends { name: string }>(x: T, i: number) => (opts.share ? { ...x, name: `Tester ${i}` } : x);
  return {
    campaignId,
    name: reportName(c),
    status: report.status,
    lockedAt: report.lockedAt?.toISOString() ?? null,
    lockedBy: opts.share ? null : report.lockedBy,
    template: tpl ? { name: tpl.name, version: tpl.version } : null,
    info: {
      gameName: c.gameName,
      originalName: c.originalName,
      testRound: c.testRound,
      genre: c.genre,
      mainTags: c.mainTags.map(genreLabel),
      secondaryTags: c.secondaryTags.map(genreLabel),
      platforms: c.platforms,
      developer: c.developer,
      ipName: c.ipName,
      devStage: c.devStage,
      taptapUrl: c.taptapUrl,
      googlePlayUrl: c.googlePlayUrl,
      steamUrl: c.steamUrl,
      iconUrl: c.iconUrl,
      aiScreening: opts.share ? null : await aiScreening(c.appId),
      startDate: isoDate(c.startDate),
      endDate: isoDate(c.endDate),
      reportDeadline: isoDate(c.reportDeadline),
      submitted: testers.length,
      invited,
    },
    config: {
      requirement: report.configRequirement,
      level: report.configLevel,
      updatedAt: report.configUpdatedAt?.toISOString() ?? null,
    },
    footage,
    footageLinks,
    overall: computed.overall,
    sections: computed.sections.map((s) => ({ ...s, details: s.details.map((d) => anonymize(d, d.tester)) })),
    general: { usp: report.usp, pros: report.pros, cons: report.cons, conclusion: report.conclusion, decision: report.decision },
    decisionLabel: labelOf(DECISIONS, report.decision),
    testers: opts.share
      ? testers.map((t) => ({ index: t.index, name: `Tester ${t.index}`, submittedAt: t.submittedAt }))
      : testers.map((t) => ({ index: t.index, name: t.name, email: t.email, submittedAt: t.submittedAt, reviewStatus: t.reviewStatus })),
    runs: runs.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      error: r.error,
      nSubmitted: r.nSubmitted,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      savedAt: r.savedAt?.toISOString() ?? null,
      savedBy: r.savedBy,
      output: r.output,
    })),
  };
}

function ensureEditable(status: string): void {
  if (status === "locked") throw new TestGameError("Report đã chốt — mở lại để sửa", 409);
}

export async function updateReport(campaignId: string, body: Record<string, unknown>, actor: string) {
  const report = await prismaApp.testReport.findUnique({ where: { campaignId } });
  if (!report) throw new TestGameError("Không tìm thấy report", 404);
  ensureEditable(report.status);
  const data: Prisma.TestReportUpdateInput = { updatedBy: actor };
  const text = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 8000) || null : null);
  if (body.sections && typeof body.sections === "object") {
    const cur = (report.sections ?? {}) as Record<string, SectionText>;
    const next = { ...cur };
    for (const [tag, v] of Object.entries(body.sections as Record<string, Partial<SectionText>>)) {
      next[tag] = { vi: String(v?.vi ?? cur[tag]?.vi ?? "").slice(0, 4000), en: String(v?.en ?? cur[tag]?.en ?? "").slice(0, 4000) };
    }
    data.sections = next as Prisma.InputJsonValue;
  }
  for (const k of ["usp", "pros", "cons", "conclusion"] as const) if (body[k] !== undefined) data[k] = text(body[k]);
  if (body.decision !== undefined) {
    const d = body.decision ? String(body.decision) : null;
    if (d && !DECISIONS.some((x) => x.key === d)) throw new TestGameError("Decision không hợp lệ");
    data.decision = d;
  }
  if (body.configRequirement !== undefined) data.configRequirement = body.configRequirement as Prisma.InputJsonValue;
  if (body.configLevel !== undefined) data.configLevel = body.configLevel as Prisma.InputJsonValue;
  await prismaApp.testReport.update({ where: { campaignId }, data });
  await audit(campaignId, actor, "report.update", { fields: Object.keys(body) });
  return getReport(campaignId);
}

/** Chốt report: cần Decision; Kết luận + Quyết định ghi về game test, game test sang Done. */
export async function lockReport(campaignId: string, actor: string) {
  const report = await prismaApp.testReport.findUnique({ where: { campaignId }, include: { campaign: true } });
  if (!report) throw new TestGameError("Không tìm thấy report", 404);
  if (report.status === "locked") throw new TestGameError("Report đã chốt");
  if (!report.decision) throw new TestGameError("Chọn Decision trước khi chốt report");
  const now = new Date();
  await prismaApp.$transaction([
    prismaApp.testReport.update({ where: { campaignId }, data: { status: "locked", lockedAt: now, lockedBy: actor } }),
    prismaApp.testCampaign.update({
      where: { id: campaignId },
      data: {
        status: "done",
        decision: report.decision,
        conclusion: report.conclusion,
        result: report.decision === "drop" ? "unsuitable" : report.decision === "recommend" ? "suitable" : null,
        updatedBy: actor,
      },
    }),
  ]);
  await audit(campaignId, actor, "report.lock", { decision: report.decision, from: report.campaign.status });
  return getReport(campaignId);
}

export async function unlockReport(campaignId: string, actor: string) {
  const report = await prismaApp.testReport.findUnique({ where: { campaignId }, include: { campaign: true } });
  if (!report) throw new TestGameError("Không tìm thấy report", 404);
  if (report.status !== "locked") throw new TestGameError("Report chưa chốt");
  const end = isoDate(report.campaign.endDate);
  const back = end && todayIct() <= end ? "testing" : "reporting";
  await prismaApp.$transaction([
    prismaApp.testReport.update({ where: { campaignId }, data: { status: "updating", lockedAt: null, lockedBy: null } }),
    prismaApp.testCampaign.update({ where: { id: campaignId }, data: { status: back, updatedBy: actor } }),
  ]);
  await audit(campaignId, actor, "report.unlock", { to: back });
  return getReport(campaignId);
}

/* ---------------- AI-01 → AI-05 → AI-02 ---------------- */

function ai01Prompt(game: { name: string; genre: string }, s: ReturnType<typeof computeSections>["sections"][number], questions: TemplateQuestion[]) {
  const answers = s.details
    .filter((d) => d.counted && (d.scores.length > 0 || d.reasons.length > 0))
    .map((d) => `Tester ${d.tester} – Score: ${d.scores.length ? `${d.scores.join(", ")}/5` : "-"} – Reason: "${d.reasons.join(" | ").replace(/\s+/g, " ").slice(0, 1200)}"`)
    .join("\n");
  return `You are a game test analyst writing one section of a game test report.
Task:
Summarize all tester feedback for ONE section (tag) into short bullet points in Vietnamese.
Input:
- Game: ${game.name} – ${game.genre}
- Section: ${s.tag}
- What this section evaluates: ${s.description || s.tag}
- Questions in this section:
${questions.map((q) => `  ${q.code}. ${q.text}`).join("\n")}
- Average score: ${s.score ?? "-"}/5 (${s.answered} testers answered)
- Tester answers, one line per tester (Tester 1 – Score: 4/5 – Reason: "..."):
${answers || "(none)"}
Requirements:
- Write 2–4 bullet points. Each bullet makes ONE clear point, max 25 words.
- Bullet 1 is the overall verdict for this section. Its tone must match the scores: mostly 4–5 = positive, mostly 3 = average or mixed, mostly 1–2 = negative.
- The next bullets give the concrete reasons: specific features, moments, problems or comparisons with other games, taken from the answers.
- Mark how many testers share each point: "(đa số)" when more than half of the answering testers say it, otherwise "(x/N tester)".
- If testers disagree, put both sides in the same bullet, e.g. "Combat cuốn hút (2/4 tester), nhưng bị chê lặp lại (2/4 tester)."
- Merge answers with the same meaning. Do not summarize tester by tester.
- State points directly. Do not write "tester cho rằng", "người chơi nói", "theo ý kiến".
- Use only information found in the answers. Do not add opinions or facts.
- Keep game terms in English (gameplay, core loop, PvP, PvE, gacha, UI/UX...). Use simple, short Vietnamese sentences.
Edge cases:
- Ignore empty or meaningless answers ("ok", "-", "không biết"...).
- Only 1 usable answer: start bullet 1 with "Nhận xét từ một tester:" and summarize it faithfully.
- No usable answer: output exactly "- Không có thông tin".
Output:
Only the bullet list. Each line starts with "- ". No title, no extra text.`;
}

function ai05Prompt(vi: Record<string, string>) {
  return `You translate the section summaries of a game test report from Vietnamese to English for a regional game publishing team.
Input (JSON: section tag → Vietnamese summary bullets):
${JSON.stringify(vi, null, 2)}
Rules:
- Translate the values only. Keep every key (section tag), the order and the bullet structure exactly the same.
- Keep game names, tag names, numbers and scores unchanged.
- Keep standard game terms in English as they are (gameplay, core loop, PvP, PvE, gacha, pay to win, UI/UX...).
- Fixed translations:
  "(đa số)" → "(majority)"
  "(x/N tester)" → "(x/N testers)"
  "Nhận xét từ một tester:" → "Single tester's feedback:"
  "Không có thông tin" → "No information"
- Write natural, concise English used in publishing reports. Do not add, remove or soften any point.
Output only the JSON with the same keys and the values in English, no extra text.`;
}

function ai02Prompt(input: {
  gameInfo: string;
  overall: number | null;
  submitted: number;
  invited: number;
  sections: string;
  usp: string[];
  improve: string[];
  redFlag: string[];
}) {
  const block = (xs: string[]) => (xs.length ? xs.join("\n") : "(none)");
  return `You are a senior game publishing analyst at a game publisher in Vietnam. You read test results and give a clear, honest assessment of the game.
Task:
Based on the test report data below, write in English: USP, Pros, Cons and Conclusion.
Input:
- Game info: ${input.gameInfo}
- Overall score: ${input.overall ?? "-"}/5 – ${input.submitted}/${input.invited} testers submitted
- Section results in English (tag – score – summary):
${input.sections}
- Open answers in Vietnamese – USP (Q36):
${block(input.usp)}
- Open answers in Vietnamese – needs improvement (Q37):
${block(input.improve)}
- Red flag answers in Vietnamese (Q38):
${block(input.redFlag)}
How to judge:
- The core experience decides the verdict. Core Loop Depth, Replayability, Progression and VN Publish Potential weigh more than Graphic, IP/Theme or UI/UX. A strong IP or nice graphics cannot save a weak core loop.
- Separate fundamental problems (core gameplay, monetization model, genre fit) from fixable ones (bugs, UI, onboarding, localization). Fundamental problems lower the verdict; fixable ones should not.
- Think about Vietnam: what VN players of this genre play now, whether this game gives them a reason to switch, and whether its platform, device requirements and monetization suit the VN market.
- Prefer points shared by several testers or coming from very high (4+) or very low (2 or less) section scores. Ignore isolated niche comments.
Writing rules:
- Write everything in English.
- USP: max 4 bullets. Only what truly makes the game stand out from games of the same genre. If nothing stands out, write one bullet saying so.
- Pros / Cons: max 4 bullets each, most important first. Each bullet max 25 words and says what + why.
- Do not repeat the same point in two sections.
- If any red flag content exists, add it to Cons, starting with "Red flag:".
- Conclusion: one paragraph, 4–5 sentences, max 100 words, summarizing what the test data says about the game:
  1. Sentence 1 = the verdict from the test data: overall quality, and whether the game is worth pursuing for the Vietnam market.
  2. Why it is good: the 1–2 biggest strengths.
  3. Why it is bad: the 1–2 biggest problems, and whether they are fundamental or fixable.
  4. VN market fit: who in Vietnam would play it, and against what kind of competitors.
  5. Optional: the one thing that would have to change for the verdict to change.
- The Conclusion is an assessment, not a decision. Do not use the decision labels "Drop", "Monitor" or "Recommend to Publish"; the admin makes that decision separately.
- Take a clear position. Do not hedge. Never write phrases like "has potential but needs improvement", "needs further improvement to reach its potential", "depends on many factors", "relatively decent". If the game is weak, say it is weak and why. If it is good, say what exactly is good.
- Plain, simple words and short sentences, professional publishing tone.
- Use only the data provided. Do not invent numbers or facts about the game. You may name well-known games of the same genre as reference points.
Output format (keep exactly):
USP:
- ...
Pros:
- ...
Cons:
- ...
Conclusion:
...
Conclusion – bad example (do not write like this):
"The game has average quality and needs to improve its gameplay to have publishing potential in Vietnam."
Conclusion – good example:
"The test data shows this game is not worth pursuing: quality is below average and the gameplay feels outdated. Its only real strength is the familiar Three Kingdoms IP, which appeals to players who enjoy collecting heroes. The core problem is the 1 vs 100 combat loop, which gets boring after 30 minutes and has almost no tactical depth (Core Loop Depth 1/5); this is a fundamental flaw that updates cannot fix. Vietnamese Three Kingdoms fans already have deeper options, so the game has little room in the market."`;
}

function parseAi02(text: string) {
  const grab = (label: string, next: string[]) => {
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n(?:${next.join("|")}):|$)`, "i");
    return text.match(re)?.[1]?.trim() ?? "";
  };
  return {
    usp: grab("USP", ["Pros", "Cons", "Conclusion"]),
    pros: grab("Pros", ["Cons", "Conclusion"]),
    cons: grab("Cons", ["Conclusion"]),
    conclusion: grab("Conclusion", ["__none__"]),
  };
}

const runningSummary = new Set<string>();

export async function startSummaryRun(campaignId: string, actor: string) {
  if (runningSummary.has(campaignId)) throw new TestGameError("Đang tổng hợp — đợi bản hiện tại xong", 409);
  const { c, tpl, testers, report, invited } = await loadReportData(campaignId);
  ensureEditable(report.status);
  if (!tpl) throw new TestGameError("Game test chưa có template");
  if (testers.length === 0) throw new TestGameError("Chưa có tester nộp questionnaire");
  const run = await prismaApp.testReportRun.create({ data: { campaignId, kind: "summary", nSubmitted: testers.length, createdBy: actor } });
  runningSummary.add(campaignId);
  await audit(campaignId, actor, "report.summarize", { runId: run.id, submitted: testers.length });
  void (async () => {
    try {
      const { sections, overall } = computeSections(tpl, testers, {});
      const game = { name: c.gameName, genre: c.genre ?? c.mainTags.map(genreLabel).join(", ") };
      const vi: Record<string, string> = {};
      await mapLimit(sections, 4, async (s) => {
        const usable = s.details.some((d) => d.counted && (d.scores.length > 0 || d.reasons.some((r) => r.trim().length > 2)));
        if (!usable) {
          vi[s.tag] = "- Không có thông tin";
          return;
        }
        const qs = tpl.questions.filter((q) => q.tag === s.tag);
        const r = await callLLM("You write concise Vietnamese bullet summaries for game test reports.", ai01Prompt(game, s, qs), 3000);
        vi[s.tag] = r.content.trim();
      });
      const ordered = Object.fromEntries(sections.map((s) => [s.tag, vi[s.tag] ?? "- Không có thông tin"]));
      const tr = await callLLM("You translate game test reports from Vietnamese to English and output JSON only.", ai05Prompt(ordered), 6000);
      const en = parseLlmJson<Record<string, string>>(tr.content);
      const sectionResults = sections
        .map((s) => `${s.tag} – ${s.scored ? `${s.score ?? "-"}/5` : "unscored"} – ${String(en[s.tag] ?? ordered[s.tag]).replace(/\n/g, " ")}`)
        .join("\n");
      const gameInfo = [
        c.gameName,
        c.originalName && `original name ${c.originalName}`,
        c.genre,
        c.platforms.join("/"),
        c.developer && `developer ${c.developer}`,
        c.ipName && `IP ${c.ipName}`,
        c.devStage && `stage ${c.devStage}`,
      ]
        .filter(Boolean)
        .join(", ");
      const r2 = await callLLM(
        "You are a senior game publishing analyst. Follow the output format exactly.",
        ai02Prompt({
          gameInfo,
          overall,
          submitted: testers.length,
          invited,
          sections: sectionResults,
          usp: openAnswers(tpl, testers, "usp"),
          improve: openAnswers(tpl, testers, "improve"),
          redFlag: openAnswers(tpl, testers, "red_flag"),
        }),
        4000,
      );
      const general = parseAi02(r2.content);
      const output = {
        sections: Object.fromEntries(sections.map((s) => [s.tag, { vi: ordered[s.tag], en: String(en[s.tag] ?? "") }])),
        ...general,
        overall,
      };
      await prismaApp.testReportRun.update({ where: { id: run.id }, data: { status: "done", output: output as Prisma.InputJsonValue, finishedAt: new Date() } });
    } catch (err) {
      console.error("[testgame] summary run", err);
      await prismaApp.testReportRun.update({ where: { id: run.id }, data: { status: "failed", error: (err as Error).message.slice(0, 500), finishedAt: new Date() } });
    } finally {
      runningSummary.delete(campaignId);
    }
  })();
  return getReport(campaignId);
}

/** Admin bấm Lưu: ghi bản tổng hợp vào report (chọn phần: sections, general). */
export async function saveRun(campaignId: string, runId: string, body: { parts?: unknown }, actor: string) {
  const run = await prismaApp.testReportRun.findUnique({ where: { id: runId } });
  if (!run || run.campaignId !== campaignId) throw new TestGameError("Không tìm thấy bản tổng hợp", 404);
  if (run.status !== "done" || !run.output) throw new TestGameError("Bản tổng hợp chưa xong");
  const report = await prismaApp.testReport.findUniqueOrThrow({ where: { campaignId } });
  ensureEditable(report.status);
  const parts = Array.isArray(body.parts) ? body.parts.map(String) : ["sections", "general", "config"];
  const out = run.output as Record<string, unknown>;
  const data: Prisma.TestReportUpdateInput = { updatedBy: actor };
  if (run.kind === "summary") {
    if (parts.includes("sections")) data.sections = out.sections as Prisma.InputJsonValue;
    if (parts.includes("general")) {
      data.usp = String(out.usp ?? "") || null;
      data.pros = String(out.pros ?? "") || null;
      data.cons = String(out.cons ?? "") || null;
      data.conclusion = String(out.conclusion ?? "") || null;
    }
  } else {
    data.configRequirement = out.requirement as Prisma.InputJsonValue;
    data.configLevel = out.level as Prisma.InputJsonValue;
    data.configUpdatedAt = new Date();
  }
  await prismaApp.testReport.update({ where: { campaignId }, data });
  await prismaApp.testReportRun.update({ where: { id: runId }, data: { savedAt: new Date(), savedBy: actor } });
  await audit(campaignId, actor, "report.save_run", { runId, kind: run.kind, parts });
  return getReport(campaignId);
}

/* ---------------- AI-03 / AI-04: cấu hình ---------------- */

interface Spec {
  os: string;
  cpu_chip: string;
  ram: string;
  gpu: string;
  storage: string;
}
interface PlatformReq {
  platform: string;
  minimum: Spec;
  recommended: Spec;
  sources: string[];
  note: string;
}

function ai03Question(c: { gameName: string; originalName: string | null; developer: string | null; platforms: string[]; taptapUrl: string | null; googlePlayUrl: string | null; steamUrl: string | null }) {
  return `You are a research assistant with web search. Find the official device / system requirements of a game.
Input:
- Game name: ${c.gameName} (original name: ${c.originalName ?? "-"})
- Developer: ${c.developer ?? "-"}
- Platforms to check: ${c.platforms.join(", ") || "Android, iOS, PC"}
- Known links: TapTap ${c.taptapUrl ?? "-"} | Google Play ${c.googlePlayUrl ?? "-"} | Steam ${c.steamUrl ?? "-"}
Task:
For each platform, find the minimum and recommended requirements.
Where to look, in this order:
1. The store pages above (Steam "System Requirements", Google Play / App Store "Requires Android / iOS", TapTap device info).
2. The developer's or publisher's official website, official social pages or announcements.
3. Reliable game databases or major gaming news sites, only if 1 and 2 have nothing.
Rules:
- Only report values you actually found on a page. Never guess or copy from similar games.
- Every platform you fill must have at least one source URL that you opened.
- Check that the page is about this exact game (name, developer, icon), not a game with a similar name.
- Mobile stores often list only the OS version and download size: fill those and write "Không rõ" for the rest.
- If sources conflict, use the most official and most recent one, and mention it in "note".
- If nothing is found for a platform, set every field to "Không rõ" and leave "sources" empty.
Output only JSON, no extra text:
{"platforms":[{"platform":"Android | iOS | PC | Console","minimum":{"os":"","cpu_chip":"","ram":"","gpu":"","storage":""},"recommended":{"os":"","cpu_chip":"","ram":"","gpu":"","storage":""},"sources":["https://..."],"note":""}]}`;
}

function ai04Prompt(gameName: string, req: unknown, library: string) {
  return `You classify how demanding a game is on players' devices.
Input:
- Game: ${gameName}
- Requirements found (JSON from the previous step):
${JSON.stringify(req, null, 2)}
- Config library – reference specs of the 5 levels, per platform:
${library}
Task:
Give a level for each platform and ONE overall level: "Rất cao", "Cao", "Trung bình", "Thấp" or "Rất thấp".
Rules:
- Compare with the library only, not with your own idea of what is "high".
- Use the recommended spec when available, otherwise the minimum spec.
- When a spec sits between two levels, choose the higher (more demanding) level.
- Mobile: rank by chip; without chip info rank by RAM. If Android and iOS differ, take the higher level. PC: rank by GPU, then CPU, then RAM. A chip / GPU newer than every row is "Rất cao". Console is not ranked.
- Overall level = the level of the mobile platform if the game is on mobile (most VN players are on mobile), otherwise the PC level.
- If the key fields of a platform are all "Không rõ" (chip / CPU, RAM, GPU), its level is "Không rõ". Do not guess.
- Reason: one Vietnamese sentence naming the spec values you compared, e.g. "Yêu cầu Snapdragon 865 và 8 GB RAM, tương đương mức Cao trong library."
- in_library: true only when the exact chip / GPU / CPU you compared is written in the library row; false when you estimated from the nearest row.
Output only JSON, no extra text:
{"overall_level":"","by_platform":[{"platform":"","level":"","reason":"","in_library":true}]}`;
}

const runningConfig = new Set<string>();

/** AI-03 (web search) → AI-04 (xếp mức theo Library); kết quả tự ghi vào report khi report chưa chốt. */
export async function startConfigRun(campaignId: string, actor: string, opts: { autoSave?: boolean } = {}) {
  if (runningConfig.has(campaignId)) throw new TestGameError("Đang cập nhật cấu hình", 409);
  const c = await prismaApp.testCampaign.findUnique({ where: { id: campaignId }, include: { report: true } });
  if (!c || c.noTest) throw new TestGameError("Không tìm thấy game test", 404);
  const run = await prismaApp.testReportRun.create({ data: { campaignId, kind: "config", createdBy: actor } });
  runningConfig.add(campaignId);
  void (async () => {
    try {
      const search = await compassWebSearch(ai03Question(c), {
        sourceHint: "Use official store pages and developer sites in any language (Chinese, Korean, English).",
        maxOutputTokens: 6000,
      });
      let requirement: { platforms: PlatformReq[]; grounded: boolean; sources: string[] };
      if (!search.grounded || !search.brief) {
        requirement = { platforms: [], grounded: false, sources: [] };
      } else {
        let parsed: { platforms?: PlatformReq[] };
        try {
          parsed = parseLlmJson<{ platforms?: PlatformReq[] }>(search.brief);
        } catch {
          const fix = await callLLM(
            "Convert the research brief into the requested JSON. Use only values stated in the brief; unknown values are \"Không rõ\". Keep only source URLs from the allowed list.",
            `Allowed source URLs:\n${search.sources.join("\n")}\n\nBrief:\n${search.brief}\n\nJSON shape:\n{"platforms":[{"platform":"","minimum":{"os":"","cpu_chip":"","ram":"","gpu":"","storage":""},"recommended":{"os":"","cpu_chip":"","ram":"","gpu":"","storage":""},"sources":[],"note":""}]}`,
            3000,
          );
          parsed = parseLlmJson<{ platforms?: PlatformReq[] }>(fix.content);
        }
        const allowed = new Set(search.sources);
        const platforms = (parsed.platforms ?? []).map((p) => ({
          ...p,
          sources: (p.sources ?? []).filter((u) => allowed.has(u) || [...allowed].some((a) => a.startsWith(u) || u.startsWith(a))),
        }));
        requirement = { platforms, grounded: true, sources: search.sources };
      }
      const keyFields = (s?: Spec) => [s?.cpu_chip, s?.ram, s?.gpu].some((v) => v && !/không rõ|unknown/i.test(v));
      const known = requirement.platforms.filter((p) => p.sources.length > 0 && (keyFields(p.recommended) || keyFields(p.minimum)));
      let level: { overall: string; byPlatform: Array<{ platform: string; level: string; reason: string; inLibrary: boolean }>; method: string };
      if (known.length === 0) {
        level = { overall: "Không rõ", byPlatform: [], method: "unknown" };
      } else {
        const settings = await getSettings();
        const library = settings.configLibrary.map((r) => `${r.level}: Android ${r.android} | iOS ${r.ios} | PC ${r.pc}`).join("\n");
        const r4 = await callLLM("You classify device requirements against a fixed library and output JSON only.", ai04Prompt(c.gameName, known, library), 2500);
        const o = parseLlmJson<{ overall_level?: string; by_platform?: Array<{ platform: string; level: string; reason: string; in_library?: boolean }> }>(r4.content);
        const by = (o.by_platform ?? []).map((p) => ({ platform: p.platform, level: p.level, reason: p.reason, inLibrary: p.in_library === true }));
        level = { overall: o.overall_level || "Không rõ", byPlatform: by, method: by.length > 0 && by.every((p) => p.inLibrary) ? "library" : "ai" };
      }
      const output = { requirement, level };
      await prismaApp.testReportRun.update({ where: { id: run.id }, data: { status: "done", output: output as unknown as Prisma.InputJsonValue, finishedAt: new Date() } });
      const fresh = await prismaApp.testReport.findUnique({ where: { campaignId } });
      if ((opts.autoSave ?? true) && fresh && fresh.status !== "locked") {
        await prismaApp.testReport.update({
          where: { campaignId },
          data: { configRequirement: requirement as unknown as Prisma.InputJsonValue, configLevel: level as unknown as Prisma.InputJsonValue, configUpdatedAt: new Date() },
        });
        await prismaApp.testReportRun.update({ where: { id: run.id }, data: { savedAt: new Date(), savedBy: actor } });
      }
    } catch (err) {
      console.error("[testgame] config run", err);
      await prismaApp.testReportRun.update({ where: { id: run.id }, data: { status: "failed", error: (err as Error).message.slice(0, 500), finishedAt: new Date() } });
    } finally {
      runningConfig.delete(campaignId);
    }
  })();
  await audit(campaignId, actor, "report.config_run", { runId: run.id });
  return { runId: run.id };
}

/* ---------------- Chia sẻ + Excel ---------------- */

export async function listShareKeys(campaignId: string) {
  const rows = await prismaApp.testShareKey.findMany({ where: { campaignId }, orderBy: { createdAt: "desc" } });
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    url: `${publicUrl()}/share/test-report/${r.key}`,
    label: r.label,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    active: !r.revokedAt && (!r.expiresAt || r.expiresAt.getTime() > now),
  }));
}

export async function createShareKey(campaignId: string, body: { label?: unknown; expiresInDays?: unknown }, actor: string) {
  const days = Number(body.expiresInDays);
  const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + Math.min(days, 365) * 86_400_000) : null;
  const key = crypto.randomBytes(18).toString("base64url");
  await prismaApp.testShareKey.create({
    data: { campaignId, key, label: body.label ? String(body.label).slice(0, 120) : null, expiresAt, createdBy: actor },
  });
  await audit(campaignId, actor, "share.create", { label: body.label ?? null, expiresAt: expiresAt?.toISOString() ?? null });
  return listShareKeys(campaignId);
}

export async function revokeShareKey(campaignId: string, id: string, actor: string) {
  await prismaApp.testShareKey.update({ where: { id }, data: { revokedAt: new Date() } });
  await audit(campaignId, actor, "share.revoke", { id });
  return listShareKeys(campaignId);
}

export async function resolveShareKey(key: string): Promise<string> {
  const row = await prismaApp.testShareKey.findUnique({ where: { key } });
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() < Date.now())) throw new TestGameError("Link chia sẻ không còn hiệu lực", 404);
  return row.campaignId;
}

export async function sharedReport(key: string) {
  return getReport(await resolveShareKey(key), { share: true });
}

export async function exportReportXlsx(campaignId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const r = await getReport(campaignId);
  const { tpl, testers } = await loadReportData(campaignId);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Report");
  ws.columns = [{ width: 28 }, { width: 12 }, { width: 10 }, { width: 70 }, { width: 70 }];
  const add = (...cells: Array<string | number | null>) => ws.addRow(cells.map((x) => x ?? ""));
  const head = add(r.name);
  head.font = { bold: true, size: 14 };
  add();
  const info: Array<[string, string]> = [
    ["Tên game", r.info.originalName ? `${r.info.gameName} (${r.info.originalName})` : r.info.gameName],
    ["Lần test", String(r.info.testRound)],
    ["Thể loại", r.info.genre ?? ""],
    ["Dòng game", r.info.mainTags.join(", ")],
    ["Platform", r.info.platforms.join(", ")],
    ["Developer", r.info.developer ?? ""],
    ["IP", r.info.ipName ?? ""],
    ["Giai đoạn phát triển", r.info.devStage ?? ""],
    ["Link TapTap", r.info.taptapUrl ?? ""],
    ["Link AI screening", r.info.aiScreening ? `${publicUrl()}${r.info.aiScreening.url}` : ""],
    ["Mức cấu hình", String((r.config.level as { overall?: string } | null)?.overall ?? "Không rõ")],
    ["Thời gian test", `${r.info.startDate ?? "?"} – ${r.info.endDate ?? "?"}`],
    ["Tester nộp / được mời", `${r.info.submitted}/${r.info.invited}`],
    ["Điểm tổng", r.overall == null ? "-" : String(r.overall)],
    ["Decision", r.decisionLabel || ""],
  ];
  for (const [k, v] of info) add(k, v).getCell(1).font = { bold: true };
  add();
  const sh = add("Section", "Điểm", "Trọng số", "Tổng kết (VI)", "Summary (EN)");
  sh.font = { bold: true };
  for (const s of r.sections) {
    const row = add(
      s.tag,
      s.scored ? (s.score ?? (s.condition ? `- (0/${s.condition.total} xác nhận có)` : "-")) : "—",
      s.weight,
      s.summary.vi,
      s.summary.en,
    );
    row.alignment = { wrapText: true, vertical: "top" };
  }
  add();
  for (const [k, v] of [
    ["USP", r.general.usp],
    ["Pros", r.general.pros],
    ["Cons", r.general.cons],
    ["Conclusion", r.general.conclusion],
  ] as const) {
    const row = add(k, null, null, v ?? "");
    row.getCell(1).font = { bold: true };
    row.alignment = { wrapText: true, vertical: "top" };
    ws.mergeCells(row.number, 4, row.number, 5);
  }

  const wa = wb.addWorksheet("Câu trả lời");
  const qs = (tpl?.questions ?? []).filter((q) => q.type !== "file");
  wa.columns = [{ width: 24 }, { width: 28 }, { width: 18 }, ...qs.map(() => ({ width: 26 }))];
  const hr = wa.addRow(["Tester", "Email", "Nộp lúc", ...qs.map((q) => `${q.code}. ${q.text}${q.tag ? ` [${q.tag}]` : ""}`)]);
  hr.font = { bold: true };
  hr.alignment = { wrapText: true, vertical: "top" };
  for (const t of testers) {
    const row = wa.addRow([
      t.name,
      t.email,
      t.submittedAt?.slice(0, 16).replace("T", " ") ?? "",
      ...qs.map((q) => {
        if (tpl && !isVisible(q, tpl.questions, t.answers)) return "";
        const v = t.answers[q.id];
        if (v == null) return "";
        if (q.type === "yes_no") return v === "yes" ? "Có" : "Không";
        return Array.isArray(v) ? v.join(", ") : v;
      }),
    ]);
    row.alignment = { wrapText: true, vertical: "top" };
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const safe = r.name.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 120);
  return { buffer, fileName: `${safe}.xlsx` };
}
