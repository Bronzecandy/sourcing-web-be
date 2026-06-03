export type AnalysisProgressDetail = {
  collected?: number;
  total?: number;
  step?: number;
  stepTotal?: number;
  capped?: boolean;
};

export type AnalysisProgressEvent = {
  phase: string;
  message: string;
  /** 0–100 */
  percent: number;
  detail?: AnalysisProgressDetail;
};

export type AnalysisProgressReporter = (event: AnalysisProgressEvent) => void;
