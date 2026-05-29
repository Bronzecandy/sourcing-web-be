import type { Response } from "express";
import type { AnalysisProgressEvent, AnalysisProgressReporter } from "../types/analysis-progress";
import { createMonotonicReporter } from "./analysis-progress-reporter";

export function streamProgressReporter(
  write: (event: AnalysisProgressEvent) => void,
  floor = 0,
): AnalysisProgressReporter {
  return createMonotonicReporter(write, floor);
}

export function wantsAnalysisStream(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return (body as { stream?: boolean }).stream === true;
}

export function createAnalysisStreamWriter(res: Response) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const writeLine = (obj: unknown) => {
    res.write(`${JSON.stringify(obj)}\n`);
  };

  return {
    report(event: AnalysisProgressEvent) {
      writeLine({ type: "progress", ...event });
    },
    done(data: unknown) {
      writeLine({ type: "done", success: true, data });
      res.end();
    },
    fail(error: string) {
      writeLine({ type: "done", success: false, error });
      res.end();
    },
  };
}
