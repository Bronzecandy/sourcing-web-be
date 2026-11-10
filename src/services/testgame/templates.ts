import type { Prisma } from "../../../generated/prisma-app/client";
import { prismaApp } from "../../utils/prisma-app";
import { testerConfig } from "../tester-config";
import { audit, TestGameError } from "./common";
import {
  BASE_TEMPLATE_QUESTIONS,
  DEFAULT_TAGS,
  defaultTagWeights,
  QUESTION_KEYS,
  QUESTION_ROLES,
  QUESTION_TYPES,
  type TagDef,
  type TemplateQuestion,
} from "./defaults";

export interface TemplateSnapshot {
  templateId: string;
  name: string;
  version: number;
  questions: TemplateQuestion[];
  tagWeights: Record<string, number>;
  tags: TagDef[];
}

let seeded = false;

/** Lần đầu: tạo danh sách tag và Khung cơ bản. */
export async function ensureTemplateSeed(): Promise<void> {
  if (seeded) return;
  const tagCount = await prismaApp.testTag.count();
  if (tagCount === 0) {
    await prismaApp.testTag.createMany({
      data: DEFAULT_TAGS.map((t, i) => ({ name: t.name, scored: t.scored, description: t.description, sortOrder: i })),
      skipDuplicates: true,
    });
  }
  const base = await prismaApp.testQuestionTemplate.findFirst({ where: { isBase: true } });
  if (!base) {
    await prismaApp.testQuestionTemplate.create({
      data: {
        name: "Khung cơ bản",
        isBase: true,
        status: "active",
        questions: BASE_TEMPLATE_QUESTIONS as unknown as Prisma.InputJsonValue,
        tagWeights: defaultTagWeights(),
        updatedBy: "system",
      },
    });
  }
  seeded = true;
}

export async function listTags(): Promise<TagDef[]> {
  await ensureTemplateSeed();
  const rows = await prismaApp.testTag.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return rows.map((r) => ({ name: r.name, scored: r.scored, description: r.description }));
}

export async function saveTag(body: Record<string, unknown>, actor: string): Promise<TagDef[]> {
  const name = String(body.name ?? "").trim();
  if (!name || name.length > 60) throw new TestGameError("Tên tag 1–60 ký tự");
  const scored = body.scored !== false;
  const description = String(body.description ?? "").trim().slice(0, 300);
  const max = await prismaApp.testTag.aggregate({ _max: { sortOrder: true } });
  await prismaApp.testTag.upsert({
    where: { name },
    create: { name, scored, description, sortOrder: (max._max.sortOrder ?? 0) + 1 },
    update: { scored, description },
  });
  await audit(null, actor, "tag.save", { name, scored });
  return listTags();
}

export async function deleteTag(name: string, actor: string): Promise<TagDef[]> {
  const templates = await prismaApp.testQuestionTemplate.findMany({ where: { status: { not: "retired" } }, select: { name: true, questions: true } });
  const used = templates.filter((t) => (t.questions as unknown as TemplateQuestion[]).some((q) => q.tag === name)).map((t) => t.name);
  if (used.length > 0) throw new TestGameError(`Tag đang dùng trong template: ${used.join(", ")}`, 409);
  await prismaApp.testTag.delete({ where: { name } });
  await audit(null, actor, "tag.delete", { name });
  return listTags();
}

type TemplateRow = Awaited<ReturnType<typeof prismaApp.testQuestionTemplate.findFirstOrThrow>>;

function templateDto(t: TemplateRow) {
  return {
    id: t.id,
    name: t.name,
    genres: t.genres,
    isBase: t.isBase,
    status: t.status,
    version: t.version,
    questions: t.questions as unknown as TemplateQuestion[],
    tagWeights: (t.tagWeights ?? {}) as Record<string, number>,
    updatedBy: t.updatedBy,
    updatedAt: t.updatedAt.toISOString(),
  };
}

export async function listTemplates() {
  await ensureTemplateSeed();
  const rows = await prismaApp.testQuestionTemplate.findMany({ orderBy: [{ isBase: "desc" }, { updatedAt: "desc" }] });
  return rows.map(templateDto);
}

export async function getTemplate(id: string) {
  const t = await prismaApp.testQuestionTemplate.findUnique({ where: { id } });
  if (!t) throw new TestGameError("Không tìm thấy template", 404);
  return templateDto(t);
}

function cleanQuestions(raw: unknown, tags: Set<string>): TemplateQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new TestGameError("Template cần ít nhất một câu hỏi");
  const ids = new Set<string>();
  const issues: string[] = [];
  const out = raw.map((r: Record<string, unknown>, i) => {
    const code = String(r.code ?? `Q${i + 1}`).trim().slice(0, 12) || `Q${i + 1}`;
    let id = String(r.id ?? "").trim() || code.toLowerCase();
    while (ids.has(id)) id = `${id}_${i}`;
    ids.add(id);
    const type = String(r.type) as TemplateQuestion["type"];
    const role = String(r.role ?? "other") as TemplateQuestion["role"];
    const text = String(r.text ?? "").trim();
    if (!text) issues.push(`${code}: thiếu nội dung câu`);
    if (!QUESTION_TYPES.includes(type)) issues.push(`${code}: loại câu không hợp lệ`);
    if (!QUESTION_ROLES.includes(role)) issues.push(`${code}: vai trò không hợp lệ`);
    const tag = r.tag ? String(r.tag).trim() : null;
    if (role !== "other" && !tag) issues.push(`${code}: câu ${role === "score" ? "Điểm" : role === "reason" ? "Lý do" : "Điều kiện"} cần tag`);
    if (tag && !tags.has(tag)) issues.push(`${code}: tag "${tag}" chưa có trong danh sách tag`);
    if (role === "score" && type !== "scale") issues.push(`${code}: câu Điểm phải là thang điểm`);
    if (role === "condition" && type !== "yes_no") issues.push(`${code}: câu Điều kiện phải là Có / Không`);
    const key = r.key && QUESTION_KEYS.includes(String(r.key) as never) ? (String(r.key) as TemplateQuestion["key"]) : null;
    const options = Array.isArray(r.options) ? r.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 30) : undefined;
    if ((type === "single" || type === "multiple") && (!options || options.length < 2)) issues.push(`${code}: cần ít nhất 2 lựa chọn`);
    const q: TemplateQuestion = {
      id,
      code,
      text: text.slice(0, 500),
      help: r.help ? String(r.help).slice(0, 300) : undefined,
      type,
      role,
      tag,
      key,
      required: r.required === true,
    };
    if (type === "scale") {
      q.scaleMin = Number(r.scaleMin ?? 1) || 1;
      q.scaleMax = Number(r.scaleMax ?? 5) || 5;
      q.minLabel = String(r.minLabel ?? "Rất tệ").slice(0, 40);
      q.maxLabel = String(r.maxLabel ?? "Rất tốt").slice(0, 40);
    }
    if (options) q.options = options;
    return q;
  });
  const conditions = new Map<string, number>();
  for (const q of out) if (q.role === "condition" && q.tag) conditions.set(q.tag, (conditions.get(q.tag) ?? 0) + 1);
  for (const [tag, n] of conditions) if (n > 1) issues.push(`Tag "${tag}" có hơn một câu Điều kiện`);
  if (issues.length > 0) throw new TestGameError("Template chưa hợp lệ", 400, issues);
  return out;
}

function cleanWeights(raw: unknown, questions: TemplateQuestion[]): Record<string, number> {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const scoredTags = [...new Set(questions.filter((q) => q.role === "score" && q.tag).map((q) => q.tag!))];
  return Object.fromEntries(
    scoredTags.map((t) => {
      const w = Number(src[t]);
      return [t, Number.isFinite(w) && w > 0 ? Math.round(w * 100) / 100 : 1];
    }),
  );
}

export async function saveTemplate(body: Record<string, unknown>, actor: string) {
  await ensureTemplateSeed();
  const tags = new Set((await listTags()).map((t) => t.name));
  const id = typeof body.id === "string" && body.id ? body.id : null;
  const current = id ? await prismaApp.testQuestionTemplate.findUnique({ where: { id } }) : null;
  if (id && !current) throw new TestGameError("Không tìm thấy template", 404);
  const name = String(body.name ?? current?.name ?? "").trim();
  if (!name) throw new TestGameError("Cần tên template");
  const genreKeys = new Set(testerConfig.genres().map((g) => g.key));
  const isBase = current?.isBase ?? false;
  const genres = isBase ? [] : Array.isArray(body.genres) ? [...new Set(body.genres.map(String).filter((g) => genreKeys.has(g)))] : current?.genres ?? [];
  const status = ["draft", "active", "retired"].includes(String(body.status)) ? String(body.status) : current?.status ?? "draft";
  if (isBase && status !== "active") throw new TestGameError("Khung cơ bản luôn ở trạng thái đang dùng");
  if (!isBase && status === "active" && genres.length === 0) throw new TestGameError("Template đang dùng cần gắn ít nhất một dòng game");
  const questions = body.questions !== undefined ? cleanQuestions(body.questions, tags) : (current?.questions as unknown as TemplateQuestion[]);
  if (!questions) throw new TestGameError("Template cần câu hỏi");
  const tagWeights = cleanWeights(body.tagWeights ?? current?.tagWeights, questions);
  const changedContent = Boolean(current) && (body.questions !== undefined || body.tagWeights !== undefined);
  const data = {
    name,
    genres,
    status,
    questions: questions as unknown as Prisma.InputJsonValue,
    tagWeights,
    updatedBy: actor,
    ...(changedContent ? { version: (current!.version ?? 1) + 1 } : {}),
  };
  const saved = current
    ? await prismaApp.testQuestionTemplate.update({ where: { id: current.id }, data })
    : await prismaApp.testQuestionTemplate.create({ data });
  await audit(null, actor, current ? "template.update" : "template.create", { templateId: saved.id, name, version: saved.version, status });
  return templateDto(saved);
}

/** Template mới bắt đầu từ bản sao Khung cơ bản (hoặc template chỉ định). */
export async function cloneTemplate(body: { fromId?: unknown; name?: unknown; genres?: unknown }, actor: string) {
  await ensureTemplateSeed();
  const src = body.fromId
    ? await prismaApp.testQuestionTemplate.findUnique({ where: { id: String(body.fromId) } })
    : await prismaApp.testQuestionTemplate.findFirst({ where: { isBase: true } });
  if (!src) throw new TestGameError("Không tìm thấy template nguồn", 404);
  return saveTemplate(
    {
      name: String(body.name ?? `${src.name} (bản sao)`),
      genres: body.genres ?? [],
      status: "draft",
      questions: src.questions,
      tagWeights: src.tagWeights,
    },
    actor,
  );
}

export async function deleteTemplate(id: string, actor: string) {
  const t = await prismaApp.testQuestionTemplate.findUnique({ where: { id } });
  if (!t) throw new TestGameError("Không tìm thấy template", 404);
  if (t.isBase) throw new TestGameError("Không xoá được Khung cơ bản");
  const used = await prismaApp.testCampaign.count({ where: { templateId: id } });
  if (used > 0) {
    await prismaApp.testQuestionTemplate.update({ where: { id }, data: { status: "retired", updatedBy: actor } });
    await audit(null, actor, "template.retire", { templateId: id });
    return { deleted: false, retired: true };
  }
  await prismaApp.testQuestionTemplate.delete({ where: { id } });
  await audit(null, actor, "template.delete", { templateId: id, name: t.name });
  return { deleted: true, retired: false };
}

/** Dòng chính đầu tiên có template đang dùng; không có thì Khung cơ bản. */
export async function pickTemplateId(mainTags: string[]): Promise<string | null> {
  await ensureTemplateSeed();
  const active = await prismaApp.testQuestionTemplate.findMany({ where: { status: "active" }, orderBy: { updatedAt: "desc" } });
  for (const tag of mainTags) {
    const hit = active.find((t) => !t.isBase && t.genres.includes(tag));
    if (hit) return hit.id;
  }
  return active.find((t) => t.isBase)?.id ?? null;
}

export async function buildSnapshot(templateId: string): Promise<TemplateSnapshot> {
  const t = await prismaApp.testQuestionTemplate.findUnique({ where: { id: templateId } });
  if (!t) throw new TestGameError("Template của game test không còn tồn tại", 409);
  const questions = t.questions as unknown as TemplateQuestion[];
  const used = new Set(questions.map((q) => q.tag).filter((x): x is string => Boolean(x)));
  const tags = (await listTags()).filter((tag) => used.has(tag.name));
  return { templateId: t.id, name: t.name, version: t.version, questions, tagWeights: (t.tagWeights ?? {}) as Record<string, number>, tags };
}

/** Template của game test: bản chốt lúc Initiate, chưa Initiate thì bản hiện tại. */
export async function campaignTemplate(c: { templateId: string | null; templateSnapshot: unknown }): Promise<TemplateSnapshot | null> {
  if (c.templateSnapshot && typeof c.templateSnapshot === "object") return c.templateSnapshot as TemplateSnapshot;
  if (!c.templateId) return null;
  try {
    return await buildSnapshot(c.templateId);
  } catch {
    return null;
  }
}

export type AnswerValue = string | number | string[] | null;
export type Answers = Record<string, AnswerValue>;

/** Câu Điểm / Lý do của tag có câu Điều kiện chỉ hiện khi trả lời Có. */
export function isVisible(q: TemplateQuestion, questions: TemplateQuestion[], answers: Answers): boolean {
  if (q.role !== "score" && q.role !== "reason") return true;
  const cond = questions.find((x) => x.role === "condition" && x.tag === q.tag);
  return !cond || answers[cond.id] === "yes";
}

export function cleanAnswers(
  snapshot: TemplateSnapshot,
  raw: unknown,
  opts: { footageRequired: boolean; footageFiles: number; draft?: boolean },
): { answers: Answers; issues: string[] } {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const answers: Answers = {};
  const issues: string[] = [];
  for (const q of snapshot.questions) {
    const v = src[q.id];
    let value: AnswerValue = null;
    if (q.type === "number") {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN;
      value = Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
    } else if (q.type === "scale") {
      const n = Number(v);
      value = Number.isInteger(n) && n >= (q.scaleMin ?? 1) && n <= (q.scaleMax ?? 5) ? n : null;
    } else if (q.type === "yes_no") {
      value = v === "yes" || v === "no" ? v : null;
    } else if (q.type === "single") {
      value = typeof v === "string" && q.options?.includes(v) ? v : null;
    } else if (q.type === "multiple") {
      value = Array.isArray(v) ? v.map(String).filter((x) => q.options?.includes(x)) : [];
      if (value.length === 0) value = null;
    } else if (q.type === "file") {
      const links = (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\s+/) : [])
        .map((x) => String(x).trim())
        .filter((x) => /^https?:\/\/\S+$/i.test(x))
        .slice(0, 10);
      value = links.length > 0 ? links : null;
    } else {
      const s = typeof v === "string" ? v.trim().slice(0, 4000) : "";
      value = s || null;
    }
    answers[q.id] = value;
  }
  if (!opts.draft) {
    for (const q of snapshot.questions) {
      if (!isVisible(q, snapshot.questions, answers)) {
        answers[q.id] = null;
        continue;
      }
      const required = q.key === "footage" ? opts.footageRequired : q.required;
      if (!required) continue;
      const empty = q.type === "file" ? answers[q.id] == null && opts.footageFiles === 0 : answers[q.id] == null;
      if (empty) issues.push(`${q.code}: ${q.text}`);
    }
  }
  return { answers, issues };
}
