import type { ReviewWindow, ReviewWindowDays, ReviewWindowMeta } from "../types/review-window";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseReviewWindow(raw: unknown): ReviewWindow {
  if (raw == null || raw === "") return { mode: "all" };
  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { mode: "all" };
    }
  } else if (typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  } else {
    return { mode: "all" };
  }

  const mode = String(obj.mode ?? "all").toLowerCase();
  if (mode === "days") {
    const d = Number(obj.days);
    if (d === 7 || d === 14 || d === 30 || d === 60) {
      return { mode: "days", days: d as ReviewWindowDays };
    }
    return { mode: "all" };
  }
  if (mode === "range") {
    const from = String(obj.from ?? "").slice(0, 10);
    const to = String(obj.to ?? "").slice(0, 10);
    if (ISO_DATE.test(from) && ISO_DATE.test(to) && from <= to) {
      return { mode: "range", from, to };
    }
    return { mode: "all" };
  }
  return { mode: "all" };
}

function parseReviewDate(date: string): Date | null {
  if (!date || date === "unknown") return null;
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function maxKnownDate(reviews: { date: string }[]): Date {
  let max: Date | null = null;
  for (const r of reviews) {
    const d = parseReviewDate(r.date);
    if (d && (!max || d > max)) max = d;
  }
  return max ?? new Date();
}

function addDaysUTC(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function reviewWindowMeta(window: ReviewWindow): ReviewWindowMeta {
  if (window.mode === "days") {
    return { reviewWindowMode: "days", reviewWindowDays: window.days };
  }
  if (window.mode === "range") {
    return {
      reviewWindowMode: "range",
      reviewFilterFrom: window.from,
      reviewFilterTo: window.to,
    };
  }
  return { reviewWindowMode: "all" };
}

export function filterReviewsByWindow<T extends { date: string }>(
  reviews: T[],
  window: ReviewWindow,
): T[] {
  if (window.mode === "all") return reviews;

  if (window.mode === "range") {
    return reviews.filter((r) => {
      const d = r.date;
      if (!d || d === "unknown") return false;
      const day = d.slice(0, 10);
      return day >= window.from && day <= window.to;
    });
  }

  const anchor = maxKnownDate(reviews);
  const cutoff = addDaysUTC(anchor, -(window.days - 1));
  const cutoffYmd = toYmd(cutoff);

  return reviews.filter((r) => {
    const d = r.date;
    if (!d || d === "unknown") return false;
    return d.slice(0, 10) >= cutoffYmd;
  });
}

/** SQL bounds for AppReview.reviewAt (inclusive calendar days in UTC). */
export function reviewWindowSqlBounds(
  window: ReviewWindow,
): { minReviewAt: Date | null; maxReviewAt: Date | null } {
  if (window.mode === "all") {
    return { minReviewAt: null, maxReviewAt: null };
  }
  if (window.mode === "range") {
    const minReviewAt = new Date(`${window.from}T00:00:00.000Z`);
    const maxReviewAt = new Date(`${window.to}T23:59:59.999Z`);
    return { minReviewAt, maxReviewAt };
  }
  const anchor = new Date();
  const min = addDaysUTC(anchor, -(window.days - 1));
  min.setUTCHours(0, 0, 0, 0);
  return { minReviewAt: min, maxReviewAt: null };
}

export function emptyReviewWindowMessage(window: ReviewWindow): string {
  if (window.mode === "days") {
    return `Không có bình luận trong ${window.days} ngày gần nhất (theo ngày review).`;
  }
  if (window.mode === "range") {
    return `Không có bình luận trong khoảng ${window.from} — ${window.to}.`;
  }
  return "Không có bình luận để phân tích.";
}
