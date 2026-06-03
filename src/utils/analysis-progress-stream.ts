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

const STREAM_HEARTBEAT_MS = Math.max(
  5_000,
  parseInt(process.env.ANALYSIS_STREAM_HEARTBEAT_MS ?? "12000", 10) || 12_000,
);

/** NDJSON stream: gửi heartbeat định kỳ để nginx/proxy không cắt khi fetch DB/LLM lâu không có chunk. */
export function createAnalysisStreamWriter(res: Response) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const writeLine = (obj: unknown) => {
    res.write(`${JSON.stringify(obj)}\n`);
  };

  let last: AnalysisProgressEvent = {
    percent: 1,
    phase: "start",
    message: "Đang xử lý…",
  };

  const heartbeat = setInterval(() => {
    writeLine({
      type: "progress",
      percent: last.percent,
      phase: "heartbeat",
      message: last.message || "Đang xử lý…",
    });
  }, STREAM_HEARTBEAT_MS);

  const stop = () => clearInterval(heartbeat);

  return {
    report(event: AnalysisProgressEvent) {
      last = event;
      writeLine({ type: "progress", ...event });
    },
    done(data: unknown) {
      stop();
      writeLine({ type: "done", success: true, data });
      res.end();
    },
    fail(error: string) {
      stop();
      writeLine({ type: "done", success: false, error });
      res.end();
    },
  };
}
