import type { AnalysisProgressDetail } from "../types/analysis-progress";
import { AI_MAX_REVIEWS_FOR_ANALYSIS } from "./review-stratified-cap";

export function buildDbFetchProgress(
  opts: {
    batchIndex: number;
    collected: number;
    totalInWindow?: number;
    capped?: boolean;
    stepTotal?: number;
    fullFetchBatchEstimate?: number;
  },
): { message: string; detail: AnalysisProgressDetail } {
  const { batchIndex, collected, totalInWindow, capped, stepTotal, fullFetchBatchEstimate } = opts;

  if (capped && totalInWindow != null) {
    const cap = AI_MAX_REVIEWS_FOR_ANALYSIS;
    return {
      message: `Đang chọn tối đa ${cap.toLocaleString("vi-VN")} bình luận đại diện (tổng ${totalInWindow.toLocaleString("vi-VN")} trong khoảng đã chọn)…`,
      detail: {
        collected,
        total: totalInWindow,
        step: batchIndex,
        stepTotal,
        capped: true,
      },
    };
  }

  const est = fullFetchBatchEstimate ?? batchIndex + 3;
  return {
    message: "Đang tải bình luận từ cơ sở dữ liệu…",
    detail: {
      collected,
      step: batchIndex,
      stepTotal: est,
      capped: false,
    },
  };
}
