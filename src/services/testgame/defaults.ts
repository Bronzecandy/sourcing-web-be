/** Danh mục và dữ liệu mặc định của module Test Game (theo Test Game Module Document v1.0). */

export const CAMPAIGN_STATUSES = ["pending", "inviting", "testing", "reporting", "done", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const ASSIGNMENT_STATUSES = ["added", "invited", "confirmed", "declined", "no_response", "in_test", "submitted"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const PLATFORMS = ["Android", "iOS", "PC", "Console"] as const;
export const SOURCES = [
  { key: "regional_bd", label: "Regional BD" },
  { key: "vn_new_game", label: "VN New Game" },
  { key: "local_team", label: "Local Team" },
] as const;
export const SECURITY_LEVELS = [
  { key: "confidential", label: "Confidential", hint: "Chỉ In-team", testerTypes: ["in_team"] },
  { key: "high", label: "High", hint: "In-team + Staff", testerTypes: ["in_team", "staff"] },
  { key: "normal", label: "Normal", hint: "Cả Collab", testerTypes: ["in_team", "staff", "collab"] },
] as const;
export const TESTER_TYPES = [
  { key: "in_team", label: "In-team" },
  { key: "staff", label: "Staff" },
  { key: "collab", label: "Collab" },
] as const;
export const EVAL_FORMATS = [
  { key: "self_play", label: "Tự chơi (90–120 phút)" },
  { key: "daily", label: "Chơi N giờ/ngày trong N ngày" },
  { key: "focused", label: "Test tập trung" },
  { key: "video", label: "Xem video gameplay" },
] as const;
export const DECISIONS = [
  { key: "drop", label: "Drop" },
  { key: "monitor", label: "Monitor" },
  { key: "recommend", label: "Recommend to Publish" },
] as const;

export const QUESTION_TYPES = ["number", "short_text", "long_text", "scale", "yes_no", "file", "single", "multiple"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const QUESTION_ROLES = ["score", "reason", "condition", "other"] as const;
export type QuestionRole = (typeof QUESTION_ROLES)[number];
/** Ý nghĩa hệ thống của câu: giờ chơi, level, footage, USP, cần cải thiện, red flag. */
export const QUESTION_KEYS = ["play_hours", "level", "footage", "usp", "improve", "red_flag"] as const;
export type QuestionKey = (typeof QUESTION_KEYS)[number];

export interface TemplateQuestion {
  id: string;
  code: string;
  text: string;
  help?: string;
  type: QuestionType;
  role: QuestionRole;
  tag?: string | null;
  key?: QuestionKey | null;
  required: boolean;
  options?: string[];
  scaleMin?: number;
  scaleMax?: number;
  minLabel?: string;
  maxLabel?: string;
}

export interface TagDef {
  name: string;
  scored: boolean;
  description: string;
}

export const DEFAULT_TAGS: TagDef[] = [
  { name: "First-time Impression", scored: true, description: "How the first 30 minutes feel: onboarding, hook, first impression." },
  { name: "Graphic", scored: true, description: "Visual quality: art style, models, effects, scene detail, overall polish." },
  { name: "IP/Theme", scored: true, description: "Appeal of the IP, setting and theme to players." },
  { name: "Freshness", scored: true, description: "How new the game feels versus games of the same genre; novel rules or mechanics." },
  { name: "Core Loop Comprehensibility", scored: true, description: "How easy the core rules and loop are to understand." },
  { name: "Core Loop Depth", scored: true, description: "How engaging the main gameplay loop is and whether it holds interest." },
  { name: "Strategic Depth", scored: true, description: "Tactical and strategic depth: meaningful choices, builds, counterplay." },
  { name: "PvP", scored: true, description: "Quality of player-versus-player modes, matchmaking and balance." },
  { name: "PvE", scored: true, description: "Quality of player-versus-environment content: stages, bosses, story modes." },
  { name: "UI/UX", scored: true, description: "Interface clarity, navigation, readability and ease of use." },
  { name: "Monetize", scored: true, description: "Monetization fairness: pressure to pay, pay-to-win, value of purchases." },
  { name: "Maneuver & Control", scored: true, description: "Controls and combat handling: responsiveness, feel, input comfort." },
  { name: "Progression", scored: true, description: "Long-term progression and motivation to keep playing." },
  { name: "Replayability", scored: true, description: "Desire to keep playing and come back." },
  { name: "VN Publish Potential", scored: true, description: "Expected success if published in Vietnam." },
  { name: "Red Flag", scored: false, description: "Sensitive content: sexual content, violence, drugs, politics." },
];

const SCALE = { type: "scale" as const, scaleMin: 1, scaleMax: 5, minLabel: "Rất tệ", maxLabel: "Rất tốt", required: true };

function q(code: string, text: string, extra: Partial<TemplateQuestion>): TemplateQuestion {
  return { id: code.toLowerCase(), code, text, type: "long_text", role: "other", required: false, tag: null, key: null, ...extra };
}

function why(code: string, tag: string): TemplateQuestion {
  return q(code, "Vì sao?", { type: "long_text", role: "reason", tag });
}

/** Khung cơ bản Q2–Q38 (Q1 lấy từ tài khoản đăng nhập). */
export const BASE_TEMPLATE_QUESTIONS: TemplateQuestion[] = [
  q("Q2", "Thời gian đã chơi (giờ)", { type: "number", key: "play_hours", required: true }),
  q("Q3", "Cấp độ nhân vật", { type: "short_text", key: "level", required: true, help: "Level / chương / tiến trình hiện tại trong game" }),
  q("Q4", "Footage đã chơi", { type: "file", key: "footage", help: "Video hoặc ảnh khi chơi; có thể dán link Drive/YouTube" }),
  q("Q5", "Cảm nhận 30 phút đầu", { ...SCALE, role: "score", tag: "First-time Impression" }),
  why("Q6", "First-time Impression"),
  q("Q7", "Đồ hoạ", { ...SCALE, role: "score", tag: "Graphic" }),
  why("Q8", "Graphic"),
  q("Q9", "IP / chủ đề có lôi cuốn không", { ...SCALE, role: "score", tag: "IP/Theme" }),
  why("Q10", "IP/Theme"),
  q("Q11", "Mức độ mới mẻ so với game cùng dòng", { ...SCALE, role: "score", tag: "Freshness" }),
  q("Q12", "Điểm mới lạ / nổi trội của luật chơi", { type: "long_text", role: "reason", tag: "Freshness" }),
  q("Q13", "Mức độ dễ hiểu của luật chơi", {
    ...SCALE,
    role: "score",
    tag: "Core Loop Comprehensibility",
    minLabel: "Rất khó hiểu",
    maxLabel: "Rất dễ hiểu",
  }),
  q("Q14", "Mức độ cuốn hút của lối chơi chính", { ...SCALE, role: "score", tag: "Core Loop Depth" }),
  why("Q15", "Core Loop Depth"),
  q("Q16", "Chiều sâu chiến thuật", { ...SCALE, role: "score", tag: "Strategic Depth" }),
  why("Q17", "Strategic Depth"),
  q("Q18", "Game có PvP không?", { type: "yes_no", role: "condition", tag: "PvP", required: true }),
  q("Q19", "Lối chơi PvP", { ...SCALE, role: "score", tag: "PvP" }),
  why("Q20", "PvP"),
  q("Q21", "Game có PvE không?", { type: "yes_no", role: "condition", tag: "PvE", required: true }),
  q("Q22", "Lối chơi PvE", { ...SCALE, role: "score", tag: "PvE" }),
  why("Q23", "PvE"),
  q("Q24", "UX/UI", { ...SCALE, role: "score", tag: "UI/UX" }),
  why("Q25", "UI/UX"),
  q("Q26", "Có cơ chế pay to win không?", { type: "yes_no", role: "condition", tag: "Monetize", required: true }),
  q("Q27", "Áp lực phải nạp", { ...SCALE, role: "score", tag: "Monetize", minLabel: "Rất áp lực", maxLabel: "Công bằng, hợp lý" }),
  q("Q28", "Điều khiển, thao tác chiến đấu", { ...SCALE, role: "score", tag: "Maneuver & Control" }),
  why("Q29", "Maneuver & Control"),
  q("Q30", "Tiến trình dài hạn (động lực chơi lâu dài)", { ...SCALE, role: "score", tag: "Progression" }),
  why("Q31", "Progression"),
  q("Q32", "Mức độ muốn tiếp tục chơi", { ...SCALE, role: "score", tag: "Replayability", minLabel: "Không muốn", maxLabel: "Rất muốn" }),
  why("Q33", "Replayability"),
  q("Q34", "Mức độ thành công nếu phát hành ở VN", {
    ...SCALE,
    role: "score",
    tag: "VN Publish Potential",
    minLabel: "Rất không",
    maxLabel: "Rất thành công",
  }),
  why("Q35", "VN Publish Potential"),
  q("Q36", "[USP] Điểm nhấn khi game ra mắt", { type: "long_text", key: "usp", required: true }),
  q("Q37", "Điểm chưa tốt / cần cải thiện", { type: "long_text", key: "improve", required: true }),
  q("Q38", "Yếu tố nhạy cảm (gợi cảm, bạo lực, chất cấm, chính trị)", {
    type: "long_text",
    role: "reason",
    tag: "Red Flag",
    key: "red_flag",
    help: "Không có thì bỏ trống",
  }),
];

export function defaultTagWeights(): Record<string, number> {
  return Object.fromEntries(DEFAULT_TAGS.filter((t) => t.scored).map((t) => [t.name, 1]));
}

export interface MailTemplateDef {
  code: string;
  name: string;
  subject: string;
  body: string;
}

const SIGNATURE = `Cảm ơn {{ TESTER_NAME }},
{{ COORDINATOR_NAME }} – {{ CONTACT_EMAIL }}`;

export const DEFAULT_MAIL_TEMPLATES: MailTemplateDef[] = [
  {
    code: "M1",
    name: "Lời mời",
    subject: "[Game Test] Lời mời test {{ GAME_NAME }}",
    body: `Chào {{ TESTER_NAME }},

Team New Game mời bạn tham gia test game **{{ GAME_NAME }}** ({{ GAME_GENRE }}).

- Platform: {{ GAME_PLATFORM }}
- Thời gian test: {{ START_DATE }} – {{ END_DATE }}
- Hình thức: {{ TEST_FORMAT }}

Bạn xác nhận tham gia hoặc từ chối trước {{ RESPONSE_DEADLINE }} tại: {{ RESPONSE_URL }}

${SIGNATURE}`,
  },
  {
    code: "M2",
    name: "Nhắc phản hồi",
    subject: "[Game Test] Nhắc phản hồi lời mời test {{ GAME_NAME }}",
    body: `Chào {{ TESTER_NAME }},

Bạn chưa phản hồi lời mời test **{{ GAME_NAME }}**. Hạn phản hồi là {{ RESPONSE_DEADLINE }}.

Xác nhận hoặc từ chối tại: {{ RESPONSE_URL }}

${SIGNATURE}`,
  },
  {
    code: "M3",
    name: "Xác nhận và hướng dẫn",
    subject: "[Game Test] Hướng dẫn test {{ GAME_NAME }}",
    body: `Chào {{ TESTER_NAME }},

Cảm ơn bạn đã xác nhận tham gia test **{{ GAME_NAME }}** ({{ GAME_PLATFORM }}). Đợt test bắt đầu ngày {{ START_DATE }}, hình thức: {{ TEST_FORMAT }}.

**Hướng dẫn tải / cài đặt**
{{ GUIDE }}

- Folder tải game: {{ APK_URL }}
- Link cài đặt: {{ INSTALL_URL }}

**Thông tin truy cập**
{{ ACCESS_INFO }}

**Nội dung cần test**
{{ TEST_NOTE }}

Vui lòng không chia sẻ bản test và thông tin truy cập ra ngoài.

${SIGNATURE}`,
  },
  {
    code: "M4",
    name: "Bắt đầu test",
    subject: "[Game Test] Bắt đầu test {{ GAME_NAME }} – hạn {{ END_DATE }}",
    body: `Chào {{ TESTER_NAME }},

Hôm nay đợt test **{{ GAME_NAME }}** ({{ GAME_PLATFORM }}) bắt đầu. Hạn test và nộp questionnaire: {{ END_DATE }}.

**Hướng dẫn**
{{ GUIDE }}

- Folder tải game: {{ APK_URL }}
- Link cài đặt: {{ INSTALL_URL }}

**Nội dung cần test**
{{ TEST_NOTE }}

Chơi xong bạn làm questionnaire tại: {{ SURVEY_URL }}
Khi nộp cần kèm 1–3 ảnh chụp màn hình có UID và level / tiến trình nhân vật để xác nhận hoàn thành.

${SIGNATURE}`,
  },
  {
    code: "M5",
    name: "Nhắc còn 2 ngày",
    subject: "[Game Test] Còn {{ DAYS_LEFT }} ngày để nộp questionnaire {{ GAME_NAME }}",
    body: `Chào {{ TESTER_NAME }},

Còn {{ DAYS_LEFT }} ngày là hết hạn test **{{ GAME_NAME }}** ({{ END_DATE }}). Bạn chưa nộp questionnaire.

Nộp tại: {{ SURVEY_URL }} (kèm 1–3 ảnh UID và level / tiến trình).

${SIGNATURE}`,
  },
  {
    code: "M6",
    name: "Nhắc ngày cuối",
    subject: "[Game Test] Hôm nay là hạn cuối nộp questionnaire {{ GAME_NAME }}",
    body: `Chào {{ TESTER_NAME }},

Hôm nay ({{ END_DATE }}) là ngày cuối test **{{ GAME_NAME }}**. Bạn nộp questionnaire trước 23:59 hôm nay tại: {{ SURVEY_URL }}

${SIGNATURE}`,
  },
  {
    code: "M7",
    name: "Kết thúc",
    subject: "[Game Test] Kết thúc đợt test {{ GAME_NAME }}",
    body: `Chào {{ TESTER_NAME }},

Đợt test **{{ GAME_NAME }}** đã kết thúc ngày {{ END_DATE }}. Cảm ơn bạn đã dành thời gian tham gia; feedback của bạn sẽ được tổng hợp vào report.

Giờ test được cộng vào hồ sơ sau khi Admin duyệt bài nộp.

${SIGNATURE}`,
  },
];

export const MAIL_CODES = DEFAULT_MAIL_TEMPLATES.map((t) => t.code);

export const MAIL_PARAMS = [
  { key: "GAME_NAME", label: "Tên game" },
  { key: "GAME_GENRE", label: "Thể loại" },
  { key: "GAME_PLATFORM", label: "Platform" },
  { key: "START_DATE", label: "Ngày bắt đầu test" },
  { key: "END_DATE", label: "Hạn test" },
  { key: "DAYS_LEFT", label: "Số ngày còn lại tới hạn test" },
  { key: "TEST_FORMAT", label: "Hình thức đánh giá" },
  { key: "RESPONSE_URL", label: "Link trang phản hồi" },
  { key: "RESPONSE_DEADLINE", label: "Hạn phản hồi lời mời" },
  { key: "GUIDE", label: "Hướng dẫn tải / cài đặt" },
  { key: "ACCESS_INFO", label: "Thông tin truy cập" },
  { key: "APK_URL", label: "Link folder APK trên Drive" },
  { key: "INSTALL_URL", label: "Link cài đặt khác" },
  { key: "TEST_NOTE", label: "Ghi chú nội dung test" },
  { key: "SURVEY_URL", label: "Link questionnaire" },
  { key: "TESTER_NAME", label: "Tên tester (trống = bạn)" },
  { key: "COORDINATOR_NAME", label: "Người phụ trách" },
  { key: "CONTACT_EMAIL", label: "Email liên hệ" },
] as const;

export const CONFIG_LEVELS = ["Rất cao", "Cao", "Trung bình", "Thấp", "Rất thấp"] as const;

export interface ConfigLibraryRow {
  level: string;
  android: string;
  ios: string;
  pc: string;
}

/** Library cấu hình (bản nháp trong doc mục 5.4, Admin sửa ở Cấu hình). */
export const DEFAULT_CONFIG_LIBRARY: ConfigLibraryRow[] = [
  {
    level: "Rất cao",
    android: "Snapdragon 8 Gen 1 trở lên (8+ Gen 1, 8 Gen 2, 8 Gen 3, 8 Elite...), 888, 7+ Gen 2; Dimensity 8100 trở lên; RAM 8 GB trở lên",
    ios: "A15 trở lên; iPhone 13 trở lên",
    pc: "RTX 3060 / 4060 / RX 6600 XT trở lên; Core i5-10600 / Ryzen 5 5600 trở lên; RAM 16 GB trở lên",
  },
  {
    level: "Cao",
    android: "Snapdragon 855, 860, 865, 870, 778G, 7 Gen 1; Dimensity 1200; RAM 6 GB",
    ios: "A13, A14; iPhone 11, 12, SE (2020)",
    pc: "GTX 1060 6 GB / GTX 1660 / RTX 2060 / RX 580; Core i5-8400 / Ryzen 5 2600; RAM 8–16 GB",
  },
  {
    level: "Trung bình",
    android: "Snapdragon 845, 720G, 730G, 695; Helio G95, G99; RAM 4 GB",
    ios: "A11, A12; iPhone 8, X, XS, XR",
    pc: "GTX 1050 Ti / GTX 960 / RX 560; Core i5-4460 / Ryzen 3 1200; RAM 8 GB",
  },
  {
    level: "Thấp",
    android: "Snapdragon 660, 665, 680; Helio G70–G88; RAM 3 GB",
    ios: "A10; iPhone 7, 7 Plus",
    pc: "Card tích hợp (Intel UHD / Iris Xe, Radeon Vega) hoặc GTX 750 Ti; Core i3; RAM 4–6 GB",
  },
  {
    level: "Rất thấp",
    android: "Snapdragon 4xx; Helio G35, P22, A22; Unisoc; RAM 1–2 GB",
    ios: "A9 trở xuống; iPhone 6s, SE (2016) trở về trước",
    pc: "Card tích hợp đời cũ (Intel HD Graphics); Pentium / Celeron / Core i3 đời cũ; RAM 2–4 GB",
  },
];

export interface TestGameSettings {
  sendHour: number;
  remindAfterDays: number;
  responseDays: number;
  remindBeforeDays: number;
  senderName: string;
  senderEmail: string;
  seatalkGroupId: string;
  driveRootFolderId: string;
  evidenceMax: number;
  footageMaxMb: number;
  configLibrary: ConfigLibraryRow[];
}

export const DEFAULT_SETTINGS: TestGameSettings = {
  sendHour: 9,
  remindAfterDays: 1,
  responseDays: 3,
  remindBeforeDays: 2,
  senderName: "Game Test Bot",
  senderEmail: "testgame@garena.vn",
  seatalkGroupId: "",
  driveRootFolderId: "",
  evidenceMax: 3,
  footageMaxMb: 200,
  configLibrary: DEFAULT_CONFIG_LIBRARY,
};

export function labelOf<T extends { key: string; label: string }>(list: readonly T[], key: string | null | undefined): string {
  return list.find((x) => x.key === key)?.label ?? key ?? "";
}
