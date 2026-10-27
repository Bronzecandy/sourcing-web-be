import type { RadarInternalTest } from "./radar-types";

/** Tình trạng test nội bộ theo appId (TestCampaign trong Tester Program). */
export async function loadInternalTests(_appIds: number[], _todayIso: string): Promise<Map<number, RadarInternalTest>> {
  return new Map();
}

/** "Tên game – team: dd/m - dd/m" cho các test đang chạy trong tuần. */
export async function testingThisWeek(_todayIso: string): Promise<string[]> {
  return [];
}