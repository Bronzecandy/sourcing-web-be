import type { RadarGameFacts, RadarOfficialPost, RadarSchedule, ScheduleKind } from "./radar-types";

const DAY_MS = 86_400_000;

const OPEN_BETA_RE = /公测|不删档不限量/;
const LAUNCH_RE = /首发|上线|定档|正式发布|全平台发布|正式开服|公测/;
const TEST_RE = /测试|封测|内测|删档|限量|首测|二测|三测|终测|体验服|招募|开测/;
const RECRUIT_RE = /招募|报名|资格/;
const EVENT_RE = /赛季|版本|更新|活动|联动|周年|直播|生日/;

/** Ngày ICT dạng YYYY-MM-DD. */
export function ictIsoDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function isoFromParts(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDays(iso: string, days: number): string {
  const t = new Date(`${iso}T00:00:00.000Z`).getTime() + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (new Date(`${toIso}T00:00:00.000Z`).getTime() - new Date(`${fromIso}T00:00:00.000Z`).getTime()) / DAY_MS,
  );
}

/** "11月26日" không có năm: chọn năm để ngày nằm trong khoảng [-200, +365] ngày quanh hôm nay. */
function inferIso(month: number, day: number, todayIso: string): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = Number(todayIso.slice(0, 4));
  for (const y of [year, year + 1, year - 1]) {
    const iso = isoFromParts(y, month, day);
    const diff = daysBetween(todayIso, iso);
    if (diff >= -200 && diff <= 365) return iso;
  }
  return isoFromParts(year, month, day);
}

export function formatViDate(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function scheduleLabel(kind: ScheduleKind | null, date: string | null, todayIso: string): string {
  const when = formatViDate(date);
  switch (kind) {
    case "launched":
      return when ? `Đã ra mắt ${when}` : "Đã ra mắt";
    case "open_beta":
      return when ? `Open beta ${when}` : "Đang open beta";
    case "launch_date":
      return when ? `Ra mắt ${when}` : "Đã chốt ngày ra mắt";
    case "closed_beta":
      if (date && date <= todayIso) return `Closed beta từ ${when}`;
      return when ? `Closed beta ${when}` : "Closed beta";
    case "test_recruit":
      return when ? `Closed beta (tuyển test) ${when}` : "Closed beta (đang tuyển test)";
    case "test_running":
      return when ? `Closed beta đang chạy từ ${when}` : "Closed beta đang chạy";
    default:
      return "";
  }
}

function make(
  kind: ScheduleKind,
  date: string | null,
  source: RadarSchedule["source"],
  raw: string | null,
  todayIso: string,
  label?: string,
): RadarSchedule {
  return { kind, date, label: label ?? scheduleLabel(kind, date, todayIso), source, raw };
}

export const EMPTY_SCHEDULE: RadarSchedule = { kind: null, date: null, label: "", source: null, raw: null };

/** Phân loại 1 đoạn chữ có ngày (vd "11月26日 首发", "定档11月26日公测"). */
function classifyDated(text: string, iso: string, todayIso: string, source: RadarSchedule["source"]): RadarSchedule | null {
  const past = iso <= todayIso;
  if (OPEN_BETA_RE.test(text)) {
    if (past) return make("open_beta", iso, source, text, todayIso);
    return make("launch_date", iso, source, text, todayIso, `Open beta ${formatViDate(iso)}`);
  }
  if (TEST_RE.test(text)) {
    if (!past) return make(RECRUIT_RE.test(text) ? "test_recruit" : "closed_beta", iso, source, text, todayIso);
    return make(RECRUIT_RE.test(text) ? "test_recruit" : "test_running", iso, source, text, todayIso);
  }
  if (LAUNCH_RE.test(text)) {
    return make(past ? "launched" : "launch_date", iso, source, text, todayIso);
  }
  if (EVENT_RE.test(text)) return make("event", iso, source, text, todayIso);
  return null;
}

export function parseHint(hint: string, todayIso: string): RadarSchedule | null {
  const text = hint.trim();
  if (!text) return null;
  const ago = text.match(/(\d+)\s*天前\s*(首发|上线|公测)/);
  if (ago) {
    const kind: ScheduleKind = ago[2] === "公测" ? "open_beta" : "launched";
    return make(kind, addDays(todayIso, -Number(ago[1])), "hints", text, todayIso);
  }
  if (/(\d+)\s*小时前\s*(首发|上线|公测)|今天\s*(首发|上线|公测)/.test(text)) {
    return make(/公测/.test(text) ? "open_beta" : "launched", todayIso, "hints", text, todayIso);
  }
  if (/昨天\s*(首发|上线|公测)/.test(text)) {
    return make(/公测/.test(text) ? "open_beta" : "launched", addDays(todayIso, -1), "hints", text, todayIso);
  }
  const dated = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (dated) {
    const iso = inferIso(Number(dated[1]), Number(dated[2]), todayIso);
    if (iso) return classifyDated(text, iso, todayIso, "hints");
  }
  if (/公测中|公测已开启|公测开启/.test(text)) return make("open_beta", null, "hints", text, todayIso);
  if (/测试下载已开启|测试中|测试进行中/.test(text)) return make("test_running", null, "hints", text, todayIso);
  if (/测试招募|招募已开启|招募中|预约测试/.test(text)) return make("test_recruit", null, "hints", text, todayIso);
  return null;
}

/** Quét bài đăng chính thức gần đây: chỉ nhận ngày đứng cạnh từ khóa lịch (公测/首发/定档/测试/招募...). */
export function scheduleFromPosts(posts: RadarOfficialPost[], todayIso: string, maxAgeDays = 21): RadarSchedule | null {
  for (const post of posts) {
    if (post.date && daysBetween(post.date, todayIso) > maxAgeDays) continue;
    const body = `${post.title}。${post.summary}`;
    for (const sentence of body.split(/[。！？!?\n；;]/)) {
      if (!OPEN_BETA_RE.test(sentence) && !LAUNCH_RE.test(sentence) && !TEST_RE.test(sentence)) continue;
      const dated = sentence.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
      if (!dated) continue;
      const iso = inferIso(Number(dated[1]), Number(dated[2]), todayIso);
      if (!iso) continue;
      const hit = classifyDated(sentence, iso, todayIso, "posts");
      if (hit && hit.kind !== "event") return { ...hit, raw: sentence.trim().slice(0, 160) };
    }
  }
  return null;
}

function infoReleaseDate(facts: RadarGameFacts): string | null {
  const d = facts.releaseDate?.trim();
  return d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

const SCHEDULE_PRIORITY: Record<ScheduleKind, number> = {
  open_beta: 0,
  launched: 1,
  launch_date: 2,
  closed_beta: 3,
  test_running: 4,
  test_recruit: 5,
  event: 9,
};

/**
 * Lịch hiện tại của game, ưu tiên trường chính thức trên TapTap:
 * flag/ngày ra mắt (information) → hints → bài đăng chính thức.
 */
export function resolveSchedule(facts: RadarGameFacts, todayIso = ictIsoDate()): RadarSchedule {
  const flag = typeof facts.flag === "number" ? facts.flag : null;
  const released = infoReleaseDate(facts);
  const hintHits = (facts.hints ?? [])
    .map((h) => parseHint(h, todayIso))
    .filter((h): h is RadarSchedule => h != null && h.kind !== "event")
    .sort((a, b) => SCHEDULE_PRIORITY[a.kind!] - SCHEDULE_PRIORITY[b.kind!]);

  const launchedByFlag = flag != null && flag >= 2;
  if (launchedByFlag || (released && released <= todayIso)) {
    const hintLaunch = hintHits.find((h) => h.kind === "launched" || h.kind === "open_beta");
    const date = released && released <= todayIso ? released : hintLaunch?.date ?? null;
    if (hintLaunch?.kind === "open_beta") return { ...hintLaunch, date: date ?? hintLaunch.date };
    return make("launched", date, released ? "info" : hintLaunch ? "hints" : "info", hintLaunch?.raw ?? null, todayIso);
  }

  if (hintHits.length > 0) return hintHits[0]!;
  if (released && released > todayIso) return make("launch_date", released, "info", null, todayIso);
  return scheduleFromPosts(facts.officialPosts ?? [], todayIso) ?? EMPTY_SCHEDULE;
}

export function playableFrom(schedule: RadarSchedule, facts: RadarGameFacts): "launched" | "open_beta" | null {
  if (schedule.kind === "open_beta") return "open_beta";
  if (schedule.kind === "launched") return "launched";
  if (typeof facts.flag === "number" && facts.flag >= 2) return "launched";
  return null;
}

/** Chuỗi so sánh lịch giữa 2 kỳ (bỏ mốc event). */
export function scheduleSignature(schedule: RadarSchedule | null | undefined): string {
  if (!schedule?.kind || schedule.kind === "event") return "";
  return `${schedule.kind}|${schedule.date ?? ""}`;
}

/** Game có mốc tương lai cụ thể (thuộc "Game sắp có thể test"). */
export function hasFutureDate(schedule: RadarSchedule | null | undefined, todayIso = ictIsoDate()): boolean {
  if (!schedule?.date) return false;
  if (!["launch_date", "closed_beta", "test_recruit"].includes(schedule.kind ?? "")) return false;
  return schedule.date > todayIso;
}

/** Có bất kỳ mốc nào (ra mắt, đang test kể cả closed test, hoặc ngày tương lai). */
export function hasAnyTiming(schedule: RadarSchedule | null | undefined): boolean {
  if (!schedule?.kind) return false;
  return schedule.kind !== "event";
}
