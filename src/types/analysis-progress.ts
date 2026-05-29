export type AnalysisProgressEvent = {
  phase: string;
  message: string;
  /** 0–100 */
  percent: number;
};

export type AnalysisProgressReporter = (event: AnalysisProgressEvent) => void;
