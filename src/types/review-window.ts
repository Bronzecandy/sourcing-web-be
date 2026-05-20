export type ReviewWindowDays = 7 | 14 | 30 | 60;

export type ReviewWindow =
  | { mode: "all" }
  | { mode: "days"; days: ReviewWindowDays }
  | { mode: "range"; from: string; to: string };

export interface ReviewWindowMeta {
  reviewWindowMode: ReviewWindow["mode"];
  reviewWindowDays?: ReviewWindowDays;
  reviewFilterFrom?: string;
  reviewFilterTo?: string;
}
