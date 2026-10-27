import { prismaApp } from "../utils/prisma-app";
import { genreKeyFromLabel, testerConfig, type Questionnaire, type QuestionnaireQuestion } from "./tester-config";

export const SURVEY_SLUG = "tester-profile";

const KNOWN_TYPES = new Set(["text_single", "text_multiple", "text_num", "single", "multiple", "matrixs"]);
const TEXT_TYPES = new Set(["text_single", "text_multiple", "text_num"]);

export type SurveyAnswers = Record<string, string | string[]>;

export interface SurveyOptionDto {
  order: number;
  label: string;
  value: string;
  jump: number | null;
  connect: number[];
  textInput: boolean;
  exclusive: boolean;
}

export interface SurveyQuestionDto {
  number: number;
  code: string;
  text: string;
  type: string;
  mustAnswer: boolean;
  page: number;
  regex: string | null;
  pic: string | null;
  video: string | null;
  semanticKey: string | null;
  genreKey: string | null;
  options: SurveyOptionDto[];
}

export interface SurveyFormDto {
  id: string;
  slug: string;
  version: number;
  title: string;
  introduction: string;
  questions: SurveyQuestionDto[];
}

export class SurveyValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join("; "));
    this.name = "SurveyValidationError";
  }
}

/** Kiểm tra cấu hình bảng hỏi theo quy tắc survey-toolkit (validate_survey.py). */
export function validateQuestionnaire(q: Questionnaire): { errors: string[]; warnings: string[]; placeholders: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const placeholders: string[] = [];
  const findPlaceholders = (where: string, text: string) => {
    for (const m of text.match(/\[[^[\]]+\]/g) ?? []) placeholders.push(`${where}: ${m}`);
  };
  if (!q.title?.trim()) errors.push("Survey Title đang trống");
  if (!q.introduction?.trim()) errors.push("Survey Introduction đang trống");
  findPlaceholders("Title", q.title ?? "");
  findPlaceholders("Introduction", q.introduction ?? "");
  const numbers = new Map<number, number>();
  let last = 0;
  q.questions.forEach((question, i) => {
    const where = `Q${question.number}`;
    if (numbers.has(question.number)) errors.push(`Số câu ${question.number} bị trùng`);
    numbers.set(question.number, i);
    if (question.number < last) warnings.push(`${where} không theo thứ tự (trước đó là ${last})`);
    last = question.number;
    if (!question.text.trim()) errors.push(`${where} không có nội dung câu hỏi`);
    if (!question.type) errors.push(`${where} không có Type`);
    else if (!KNOWN_TYPES.has(question.type)) warnings.push(`${where} có Type lạ "${question.type}"`);
    if (TEXT_TYPES.has(question.type) && question.options.length > 0) warnings.push(`${where} là câu nhập chữ nhưng có dòng đáp án`);
    if ((question.type === "single" || question.type === "multiple") && question.options.length === 0) {
      errors.push(`${where} là câu chọn nhưng không có đáp án`);
    }
    findPlaceholders(where, question.text);
    for (const opt of question.options) findPlaceholders(where, opt.label);
  });
  for (const question of q.questions) {
    for (const opt of question.options) {
      for (const ref of [...(opt.jump ? [opt.jump] : []), ...opt.connect]) {
        if (!numbers.has(ref)) errors.push(`Q${question.number} — đáp án "${opt.label}" trỏ tới Q${ref} không tồn tại`);
      }
    }
  }
  return { errors, warnings, placeholders };
}

function optionValue(q: QuestionnaireQuestion, label: string): string {
  if (q.semanticKey === "genres" || q.semanticKey === "favorite_genre") return genreKeyFromLabel(label) ?? label;
  if (q.semanticKey === "platforms") {
    return testerConfig.mapping().device.find((d) => d.label === label)?.key ?? label;
  }
  if (q.semanticKey === "weekly_play") {
    const level = testerConfig.mapping().weeklyPlay.find((w) => w.label === label)?.level;
    return level != null ? String(level) : label;
  }
  return label;
}

/** Ghi bảng hỏi từ data/tester/questionnaire.json vào DB (tạo mới hoặc khi version tăng). */
export async function seedSurveyForm(opts: { force?: boolean } = {}): Promise<{ seeded: boolean; version: number }> {
  const q = testerConfig.questionnaire();
  const report = validateQuestionnaire(q);
  if (report.errors.length > 0) throw new SurveyValidationError(report.errors);
  const existing = await prismaApp.surveyForm.findUnique({ where: { slug: q.slug } });
  if (existing && existing.version >= q.version && !opts.force) return { seeded: false, version: existing.version };

  await prismaApp.$transaction(async (tx) => {
    const form = existing
      ? await tx.surveyForm.update({
          where: { id: existing.id },
          data: { version: q.version, title: q.title, introduction: q.introduction, supplement: q.supplement ?? null, isActive: true },
        })
      : await tx.surveyForm.create({
          data: { slug: q.slug, version: q.version, title: q.title, introduction: q.introduction, supplement: q.supplement ?? null },
        });
    await tx.surveyQuestion.deleteMany({ where: { formId: form.id } });
    for (const question of q.questions) {
      await tx.surveyQuestion.create({
        data: {
          formId: form.id,
          number: question.number,
          code: `Q${question.number}`,
          text: question.text,
          type: question.type,
          mustAnswer: question.mustAnswer,
          page: question.page,
          pic: question.pic,
          video: question.video,
          regex: question.regex,
          semanticKey: question.semanticKey,
          genreKey: question.genreKey,
          options: {
            create: question.options.map((opt, i) => ({
              order: i + 1,
              label: opt.label,
              value: optionValue(question, opt.label),
              jump: opt.jump,
              connect: opt.connect,
              fix: opt.fix,
              exclusive: opt.exclusive,
              textInput: opt.textInput,
            })),
          },
        },
      });
    }
  });
  return { seeded: true, version: q.version };
}

export async function getActiveSurvey(): Promise<SurveyFormDto> {
  let form = await prismaApp.surveyForm.findUnique({
    where: { slug: SURVEY_SLUG },
    include: { questions: { orderBy: { number: "asc" }, include: { options: { orderBy: { order: "asc" } } } } },
  });
  if (!form || form.version < testerConfig.questionnaire().version) {
    await seedSurveyForm();
    form = await prismaApp.surveyForm.findUniqueOrThrow({
      where: { slug: SURVEY_SLUG },
      include: { questions: { orderBy: { number: "asc" }, include: { options: { orderBy: { order: "asc" } } } } },
    });
  }
  return {
    id: form.id,
    slug: form.slug,
    version: form.version,
    title: form.title,
    introduction: form.introduction,
    questions: form.questions.map((q) => ({
      number: q.number,
      code: q.code,
      text: q.text,
      type: q.type,
      mustAnswer: q.mustAnswer,
      page: q.page,
      regex: q.regex,
      pic: q.pic,
      video: q.video,
      semanticKey: q.semanticKey,
      genreKey: q.genreKey,
      options: q.options.map((o) => ({
        order: o.order,
        label: o.label,
        value: o.value,
        jump: o.jump,
        connect: o.connect,
        textInput: o.textInput,
        exclusive: o.exclusive,
      })),
    })),
  };
}

function selectedValues(answer: string | string[] | undefined): string[] {
  if (answer == null) return [];
  return (Array.isArray(answer) ? answer : [answer]).map((v) => String(v)).filter((v) => v.trim() !== "");
}

/** Câu đang hiện: câu không bị CONNECT ẩn, cộng câu được mở bởi đáp án đã chọn; bỏ câu nằm trong vùng JUMP. */
export function visibleQuestionNumbers(form: SurveyFormDto, answers: SurveyAnswers): Set<number> {
  const connected = new Set<number>();
  for (const q of form.questions) for (const o of q.options) for (const n of o.connect) connected.add(n);
  const visible = new Set<number>(form.questions.filter((q) => !connected.has(q.number)).map((q) => q.number));
  const skipped = new Set<number>();
  for (const q of form.questions) {
    const chosen = selectedValues(answers[q.code]);
    for (const o of q.options) {
      if (!chosen.includes(o.value)) continue;
      for (const n of o.connect) visible.add(n);
      if (o.jump) for (const other of form.questions) if (other.number > q.number && other.number < o.jump) skipped.add(other.number);
    }
  }
  for (const n of skipped) visible.delete(n);
  return visible;
}

export function validateAnswers(form: SurveyFormDto, answers: SurveyAnswers): string[] {
  const issues: string[] = [];
  const visible = visibleQuestionNumbers(form, answers);
  for (const q of form.questions) {
    if (!visible.has(q.number)) continue;
    const raw = answers[q.code];
    const values = selectedValues(raw);
    if (values.length === 0) {
      if (q.mustAnswer) issues.push(`${q.code}: chưa trả lời`);
      continue;
    }
    if (q.type === "single" || q.type === "multiple") {
      const allowed = new Set(q.options.map((o) => o.value));
      const bad = values.filter((v) => !allowed.has(v));
      if (bad.length > 0) issues.push(`${q.code}: đáp án không hợp lệ`);
      if (q.type === "single" && values.length > 1) issues.push(`${q.code}: chỉ chọn một đáp án`);
    } else if (q.type === "text_num" && values.some((v) => !Number.isFinite(Number(v)))) {
      issues.push(`${q.code}: cần nhập số`);
    }
    if (q.regex) {
      try {
        const re = new RegExp(q.regex);
        if (values.some((v) => !re.test(v))) issues.push(`${q.code}: sai định dạng`);
      } catch {
        // regex cấu hình lỗi — bỏ qua
      }
    }
  }
  return issues;
}

function labelOf(q: SurveyQuestionDto | undefined, value: string | undefined): string | null {
  if (!q || value == null) return null;
  return q.options.find((o) => o.value === value)?.label ?? value;
}

export interface ProfileFields {
  name: string;
  office: string | null;
  team: string | null;
  ageRange: string | null;
  platforms: string[];
  gender: string | null;
  weeklyPlayLabel: string | null;
  weeklyPlayLevel: number | null;
  payLabel: string | null;
  payTier: string | null;
  testTimeLabel: string | null;
  favoriteGenre: string | null;
  genres: string[];
}

/** Dựng hồ sơ (tab Basic Profile + Genre Data cũ) từ câu trả lời, dùng bảng Mapping. */
export function buildProfile(form: SurveyFormDto, answers: SurveyAnswers, fallbackName: string): ProfileFields {
  const bySemantic = (key: string) => form.questions.find((q) => q.semanticKey === key);
  const one = (key: string) => {
    const q = bySemantic(key);
    return q ? selectedValues(answers[q.code])[0] : undefined;
  };
  const many = (key: string) => {
    const q = bySemantic(key);
    return q ? selectedValues(answers[q.code]) : [];
  };
  const mapping = testerConfig.mapping();
  const weeklyValue = one("weekly_play");
  const weeklyLabel = labelOf(bySemantic("weekly_play"), weeklyValue);
  const payLabel = labelOf(bySemantic("pay"), one("pay"));
  const testLabel = labelOf(bySemantic("test_time"), one("test_time"));
  return {
    name: one("name")?.trim() || fallbackName,
    office: labelOf(bySemantic("office"), one("office")),
    team: labelOf(bySemantic("team"), one("team")),
    ageRange: labelOf(bySemantic("age"), one("age")),
    platforms: many("platforms"),
    gender: labelOf(bySemantic("gender"), one("gender")),
    weeklyPlayLabel: weeklyLabel,
    weeklyPlayLevel: weeklyValue && /^\d+$/.test(weeklyValue) ? Number(weeklyValue) : null,
    payLabel,
    payTier: payLabel ? (mapping.payment.find((p) => p.label === payLabel)?.tier ?? null) : null,
    testTimeLabel: testLabel ? `${testLabel} / tuần` : null,
    favoriteGenre: one("favorite_genre") ?? null,
    genres: many("genres").filter((g) => g !== "Other"),
  };
}

/** Câu trả lời từng dòng game (tab Genre Data cũ) — đầu vào chấm hardcore. */
export function genreAnswers(form: SurveyFormDto, answers: SurveyAnswers): Array<{ genre: string; raw: string }> {
  const visible = visibleQuestionNumbers(form, answers);
  const out: Array<{ genre: string; raw: string }> = [];
  for (const q of form.questions) {
    if (q.semanticKey !== "genre_detail" || !q.genreKey || !visible.has(q.number)) continue;
    const raw = selectedValues(answers[q.code]).join("\n").trim();
    if (raw) out.push({ genre: q.genreKey, raw });
  }
  return out;
}
