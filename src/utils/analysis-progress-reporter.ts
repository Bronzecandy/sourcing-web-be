import type { AnalysisProgressEvent, AnalysisProgressReporter } from "../types/analysis-progress";

/** Chỉ gửi % không lùi; cho phép đổi message ở cùng % (heartbeat LLM). */
export function createMonotonicReporter(
  onProgress?: AnalysisProgressReporter,
  floor = 0,
): AnalysisProgressReporter {
  let max = floor;
  let lastMessage = "";
  return (event: AnalysisProgressEvent) => {
    const p = Math.min(99, Math.max(floor, event.percent, max));
    const nextMax = Math.max(max, p);
    const message = event.message?.trim() ?? "";
    const messageChanged = message !== "" && message !== lastMessage;
    if (nextMax > max || (messageChanged && nextMax >= max)) {
      max = nextMax;
      if (messageChanged) lastMessage = message;
      onProgress?.({
        percent: max,
        message: message || lastMessage,
        phase: event.phase,
        detail: event.detail,
      });
    }
  };
}

export function createProgressStepReporter(
  onProgress?: AnalysisProgressReporter,
  floor = 0,
) {
  const emit = createMonotonicReporter(onProgress, floor);
  const step = (
    percent: number,
    message: string,
    phase: string,
    detail?: AnalysisProgressEvent["detail"],
  ) => emit({ percent, message, phase, detail });
  return { step, emit };
}

const LLM_WAIT_MESSAGES = [
  "AI đang đọc và phân loại bình luận…",
  "AI đang tổng hợp ý kiến người chơi…",
  "Vẫn đang xử lý — game nhiều review có thể mất vài phút…",
  "AI đang hoàn thiện phân tích chi tiết…",
];

/**
 * Cập nhật % dần trong lúc chờ LLM (tránh đứng im ở 28% rồi nhảy 100%).
 */
export async function runWithLlmHeartbeat<T>(
  report: AnalysisProgressReporter | undefined,
  startPct: number,
  endPct: number,
  contextLabel: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!report) return fn();

  const span = Math.max(1, endPct - startPct);
  let tick = 0;
  let heartbeatPct = startPct;

  const pulse = () => {
    tick += 1;
    const t = Math.min(1, tick / 14);
    const eased = 1 - Math.exp(-t * 2.2);
    const candidate = startPct + Math.floor(span * eased * 0.92);
    const next = Math.min(endPct - 1, Math.max(heartbeatPct, candidate));
    if (next > heartbeatPct) heartbeatPct = next;
    const msg =
      tick === 1
        ? `${contextLabel} (một lượt)…`
        : LLM_WAIT_MESSAGES[(tick - 2) % LLM_WAIT_MESSAGES.length]!;
    report({ percent: heartbeatPct, message: msg, phase: "llm" });
  };

  pulse();
  const interval = setInterval(pulse, 8_000);

  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}
