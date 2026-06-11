import { logDiag } from "./process-diagnostics";

let activePrecomputeBlockers = 0;
let precomputePauseResolvers: Array<() => void> = [];

function notifyPrecomputeCanResume(): void {
  const waiters = precomputePauseResolvers;
  precomputePauseResolvers = [];
  for (const r of waiters) r();
}

/** Tạm dừng precompute khi có tác vụ DB nặng (AI stream, distribution overview, …). */
export function beginPrecomputePause(label: string): void {
  activePrecomputeBlockers += 1;
  if (activePrecomputeBlockers === 1) {
    logDiag("precompute-paused", { label, activePrecomputeBlockers });
    console.log(`[precompute] Paused — ${label}`);
  }
}

export function endPrecomputePause(label: string): void {
  activePrecomputeBlockers = Math.max(0, activePrecomputeBlockers - 1);
  if (activePrecomputeBlockers === 0) {
    logDiag("precompute-resumed", { label });
    console.log(`[precompute] Resumed after ${label}`);
    notifyPrecomputeCanResume();
  }
}

/** @deprecated alias — dùng beginPrecomputePause */
export const beginAnalysisStream = beginPrecomputePause;

/** @deprecated alias — dùng endPrecomputePause */
export const endAnalysisStream = endPrecomputePause;

export async function waitForPrecomputeSlot(): Promise<void> {
  while (activePrecomputeBlockers > 0) {
    await new Promise<void>((resolve) => {
      precomputePauseResolvers.push(resolve);
    });
  }
}

export function isPrecomputePaused(): boolean {
  return activePrecomputeBlockers > 0;
}

/** @deprecated alias */
export const isAnalysisStreamActive = isPrecomputePaused;
