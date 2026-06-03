import { logDiag } from "./process-diagnostics";

let activeAnalysisStreams = 0;
let precomputePauseResolvers: Array<() => void> = [];

function notifyPrecomputeCanResume(): void {
  const waiters = precomputePauseResolvers;
  precomputePauseResolvers = [];
  for (const r of waiters) r();
}

/** Tạm dừng precompute giữa các batch khi có luồng phân tích AI (tránh poolWaiting hàng trăm). */
export function beginAnalysisStream(label: string): void {
  activeAnalysisStreams += 1;
  if (activeAnalysisStreams === 1) {
    logDiag("precompute-paused-for-analysis", { label, activeAnalysisStreams });
  }
}

export function endAnalysisStream(label: string): void {
  activeAnalysisStreams = Math.max(0, activeAnalysisStreams - 1);
  if (activeAnalysisStreams === 0) {
    logDiag("precompute-resume-after-analysis", { label });
    notifyPrecomputeCanResume();
  }
}

export async function waitForPrecomputeSlot(): Promise<void> {
  if (activeAnalysisStreams === 0) return;
  await new Promise<void>((resolve) => {
    precomputePauseResolvers.push(resolve);
  });
}

export function isAnalysisStreamActive(): boolean {
  return activeAnalysisStreams > 0;
}
