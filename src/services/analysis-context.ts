import { prisma } from "../utils/prisma";
import type { TapTapRawApp } from "../types";

export interface AnalysisContext {
  appId: number;
  gameName: string;
  iconUrl: string | null;
  tagValues: string[];
  developerName: string | null;
  publisherName: string | null;
  /**
   * true nếu developerName được lấy từ publisher (snapshot không có field dev riêng)
   * — nhiều game CN chỉ khai báo publisher / vận hành.
   */
  developerResolvedViaPublisherFallback?: boolean;
  /** Cài đặt gói ước tính (MB), từ TapTap raw nếu có */
  installSizeMb?: number | null;
  /** Số ngày từ lần cập nhật trang (theo update_time) */
  daysSinceUpdate?: number | null;
  /** fans_count từ stat nếu có */
  fansCount?: number | null;
  /** Chuỗi ghép để khớp keyword lib (IP/system/art) */
  searchHaystack?: string | null;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function pickEntityName(obj: unknown): string | null {
  if (typeof obj === "string") return str(obj);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  return (
    str(o.name) ??
    str(o.title) ??
    str(o.value) ??
    str(o.group_name) ??
    str(o.groupName) ??
    null
  );
}

/** Gộp root `app` (TapTap đôi khi bọc payload trong app). Ưu tiên field ở lớp ngoài. */
export function tapTapEffectiveRoot(raw: Record<string, unknown>): Record<string, unknown> {
  const inner = raw.app;
  if (inner && typeof inner === "object") {
    return { ...(inner as Record<string, unknown>), ...raw };
  }
  return raw;
}

function firstFromEntityArray(arr: unknown): string | null {
  if (!Array.isArray(arr)) return null;
  for (const item of arr) {
    const n =
      typeof item === "string"
        ? str(item)
        : pickEntityName(item);
    if (n) return n;
  }
  return null;
}

/** TapTap CN: hàng title「厂商」= tên hiển thị;「供应商」/ key developer_legal_name = pháp nhân */
function textFromInformationRowByPredicate(arr: unknown, pred: (r: Record<string, unknown>) => boolean): string | null {
  if (!Array.isArray(arr)) return null;
  for (const row of arr) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (!pred(r)) continue;
    const t = str(r.text) ?? str(r.value);
    if (t) return t;
  }
  return null;
}

function isVendorDisplayRow(r: Record<string, unknown>): boolean {
  const title = str(r.title);
  if (title === "厂商") return true;
  if (title && /^developer$/i.test(title)) return true;
  return false;
}

function isSupplierLegalRow(r: Record<string, unknown>): boolean {
  if (typeof r.key === "string" && r.key === "developer_legal_name") return true;
  const title = str(r.title);
  if (title === "供应商") return true;
  if (title && /^publisher$/i.test(title)) return true;
  return false;
}

/** TapTap thường đặt tên nhà phát hành trong `information` / `information_bar` (mảng object có .text), không có field developer riêng. */
function textsFromInformationRows(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const row of arr) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const t = str(r.text) ?? str(r.value) ?? str(r.label);
    if (t) out.push(t);
  }
  return out;
}

/** Extract developer/publisher from various TapTap raw shapes (ZH/EN, nested, publisher-only). */
export function extractDeveloperPublisher(raw: TapTapRawApp | Record<string, unknown> | null | undefined): {
  developerName: string | null;
  publisherName: string | null;
  developerResolvedViaPublisherFallback: boolean;
} {
  const empty = { developerName: null, publisherName: null, developerResolvedViaPublisherFallback: false };
  if (!raw || typeof raw !== "object") return empty;

  const o = tapTapEffectiveRoot(raw as Record<string, unknown>);

  let developerName =
    str(o.developer) ??
    pickEntityName(o.developer) ??
    str((o.developer_info as Record<string, unknown> | undefined)?.name) ??
    str((o.developerInfo as Record<string, unknown> | undefined)?.name) ??
    str((o.develop as Record<string, unknown> | undefined)?.name) ??
    str((o.cp as Record<string, unknown> | undefined)?.name) ??
    str(typeof o.cp_name === "string" ? o.cp_name : null) ??
    str(typeof o.cpName === "string" ? o.cpName : null) ??
    str((o.team as Record<string, unknown> | undefined)?.name) ??
    str((o.studio as Record<string, unknown> | undefined)?.name) ??
    str(o.manufacturer) ??
    str(o.vendor) ??
    str(o.supplier) ??
    firstFromEntityArray(o.developers);

  let publisherName =
    str(o.publisher) ??
    pickEntityName(o.publisher) ??
    str((o.publisher_info as Record<string, unknown> | undefined)?.name) ??
    str((o.publisherInfo as Record<string, unknown> | undefined)?.name) ??
    str((o.operator as Record<string, unknown> | undefined)?.name) ??
    firstFromEntityArray(o.publishers);

  const infoTexts = textsFromInformationRows(o.information);
  const barTexts = textsFromInformationRows(o.information_bar);

  const devFromRows =
    textFromInformationRowByPredicate(o.information, isVendorDisplayRow) ??
    textFromInformationRowByPredicate(o.information_bar, isVendorDisplayRow);
  const pubFromRows =
    textFromInformationRowByPredicate(o.information, isSupplierLegalRow) ??
    textFromInformationRowByPredicate(o.information_bar, isSupplierLegalRow);

  if (!developerName && devFromRows) developerName = devFromRows;
  if (!publisherName && pubFromRows) publisherName = pubFromRows;

  if (!developerName) {
    developerName = infoTexts[0] ?? barTexts[0] ?? null;
  }
  if (!publisherName) {
    publisherName = infoTexts[1] ?? barTexts[1] ?? null;
  }

  let developerResolvedViaPublisherFallback = false;
  if (!developerName && publisherName) {
    developerName = publisherName;
    developerResolvedViaPublisherFallback = true;
  }

  return { developerName, publisherName, developerResolvedViaPublisherFallback };
}

function tagStringsFromArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      if (item.trim()) out.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const v =
      str(o.value) ??
      str(o.name) ??
      str(o.title) ??
      str(o.tag_name) ??
      str(o.label) ??
      str(o.text);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Genre / category tags from TapTap detail JSON (several API shapes + nested `app`).
 */
export function extractTags(raw: TapTapRawApp | Record<string, unknown> | null | undefined): string[] {
  if (!raw || typeof raw !== "object") return [];
  const root = tapTapEffectiveRoot(raw as Record<string, unknown>);

  const fromGenre: string[] = [];
  if (typeof root.genre === "string" && root.genre.trim()) fromGenre.push(root.genre.trim());
  else if (Array.isArray(root.genre)) fromGenre.push(...tagStringsFromArray(root.genre));

  const buckets = [
    ...tagStringsFromArray(root.tags),
    ...tagStringsFromArray(root.tag_list),
    ...tagStringsFromArray(root.game_tags),
    ...tagStringsFromArray(root.genre_tags),
    ...tagStringsFromArray(root.genres),
    ...tagStringsFromArray(root.categories),
    ...fromGenre,
  ];

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const x of buckets) {
    const k = x.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(x);
  }
  return deduped;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Dung lượng cài (MB). Một số API trả bytes (lớn), số khác trả MB trực tiếp.
 */
export function extractInstallSizeMb(raw: TapTapRawApp | Record<string, unknown> | null | undefined): number | null {
  if (!raw || typeof raw !== "object") return null;
  const o = tapTapEffectiveRoot(raw as Record<string, unknown>);
  const candidates = [
    num(o.apk_size),
    num(o.package_size),
    num(o.file_size),
    num(o.download_size),
    num((o.stat as Record<string, unknown> | undefined)?.download_size),
    num((o.stat as Record<string, unknown> | undefined)?.file_size),
    num((o.apk as Record<string, unknown> | undefined)?.file_size),
    num((o.android as Record<string, unknown> | undefined)?.package_size),
  ];
  for (const c of candidates) {
    if (c == null || c <= 0) continue;
    if (c > 512) return c / (1024 * 1024);
    return c;
  }
  return null;
}

export function extractDaysSinceUpdate(
  raw: TapTapRawApp | Record<string, unknown> | null | undefined,
): number | null {
  if (!raw || typeof raw !== "object") return null;
  const o = tapTapEffectiveRoot(raw as Record<string, unknown>);
  const t = num(o.update_time);
  if (t == null || t <= 0) return null;
  const sec = t > 1e12 ? t / 1000 : t;
  const days = (Date.now() / 1000 - sec) / 86400;
  return Math.max(0, days);
}

export function extractFansCount(raw: TapTapRawApp | Record<string, unknown> | null | undefined): number | null {
  if (!raw || typeof raw !== "object") return null;
  const o = tapTapEffectiveRoot(raw as Record<string, unknown>);
  const stat = o.stat as Record<string, unknown> | undefined;
  const n = num(stat?.fans_count);
  if (n == null || n < 0) return null;
  return n;
}

export function buildSearchHaystack(raw: TapTapRawApp | Record<string, unknown> | null | undefined): string {
  if (!raw || typeof raw !== "object") return "";
  const root = tapTapEffectiveRoot(raw as Record<string, unknown>);
  const o = root as unknown as TapTapRawApp;
  const chunks: string[] = [];
  if (typeof o.title === "string") chunks.push(o.title);
  chunks.push(...extractTags(raw));
  const desc = o.description?.text;
  if (typeof desc === "string") chunks.push(desc);
  if (typeof o.rec_text === "string") chunks.push(o.rec_text);
  const dn = o.developer_note?.text;
  if (typeof dn === "string") chunks.push(dn);
  return chunks.join(" \n ");
}

export async function loadAnalysisContext(appId: number): Promise<AnalysisContext | null> {
  const latestRank = await prisma.appRank.findFirst({
    where: { appId },
    orderBy: { date: "desc" },
  });
  const raw = (latestRank?.raw ?? null) as TapTapRawApp | null;
  const gameName = raw?.title ?? `App #${appId}`;
  const iconUrl = raw?.icon?.url ?? null;
  const { developerName, publisherName, developerResolvedViaPublisherFallback } = extractDeveloperPublisher(raw);
  const tagValues = extractTags(raw);
  const installSizeMb = extractInstallSizeMb(raw as TapTapRawApp);
  const daysSinceUpdate = extractDaysSinceUpdate(raw as TapTapRawApp);
  const fansCount = extractFansCount(raw as TapTapRawApp);
  const searchHaystack = buildSearchHaystack(raw as TapTapRawApp);

  return {
    appId,
    gameName,
    iconUrl,
    tagValues,
    developerName,
    publisherName,
    developerResolvedViaPublisherFallback,
    installSizeMb,
    daysSinceUpdate,
    fansCount,
    searchHaystack,
  };
}

/** When raw app is already loaded (e.g. external analysis with icon/name) */
export function buildAnalysisContextFromRaw(
  appId: number,
  gameName: string,
  iconUrl: string | null,
  raw: TapTapRawApp | Record<string, unknown> | null | undefined,
): AnalysisContext {
  const { developerName, publisherName, developerResolvedViaPublisherFallback } = extractDeveloperPublisher(raw ?? undefined);
  const tagValues = extractTags(raw ?? undefined);
  const r = raw as TapTapRawApp | undefined;
  return {
    appId,
    gameName,
    iconUrl,
    tagValues,
    developerName,
    publisherName,
    developerResolvedViaPublisherFallback,
    installSizeMb: extractInstallSizeMb(r),
    daysSinceUpdate: extractDaysSinceUpdate(r),
    fansCount: extractFansCount(r),
    searchHaystack: buildSearchHaystack(r),
  };
}
