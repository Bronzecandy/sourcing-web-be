import { prismaApp } from "../../utils/prisma-app";
import { addDays, audit, getSettings, hourIct, ictDateOf, isoDate, TestGameError, todayIct } from "./common";
import { responseDeadline, sendCampaignMail } from "./mail";

interface RunSummary {
  date: string;
  at: string;
  campaigns: number;
  mails: Record<string, number>;
  failed: number;
  transitions: string[];
}

let running = false;

async function lastRunDate(): Promise<string | null> {
  const row = await prismaApp.testGameSetting.findUnique({ where: { key: "scheduler" } });
  return (row?.value as { date?: string } | null)?.date ?? null;
}

/** Inviting → Testing ngay khi tới ngày bắt đầu, không đợi lượt gửi mail trong ngày (vd Initiate đúng ngày bắt đầu). */
export async function startDueCampaigns(where: { id?: string } = {}): Promise<string[]> {
  const due = await prismaApp.testCampaign.findMany({
    where: { ...where, status: "inviting", noTest: false, startDate: { lte: new Date(`${todayIct()}T00:00:00.000Z`) } },
    select: { id: true, gameName: true },
  });
  for (const c of due) {
    await prismaApp.testCampaign.update({ where: { id: c.id }, data: { status: "testing" } });
    await prismaApp.testAssignment.updateMany({ where: { campaignId: c.id, status: "confirmed" }, data: { status: "in_test" } });
    await audit(c.id, "system", "campaign.status", { from: "inviting", to: "testing" });
  }
  return due.map((c) => `${c.gameName}: Testing`);
}

/**
 * Lịch 09:00 (giờ cấu hình): chỉ xét game test Inviting / Testing có ngày bắt đầu, hạn test và ít nhất một tester.
 * Trạng thái tester được đọc lại ngay lúc gửi, nên ai nộp / phản hồi trước giờ gửi không bị nhắc.
 */
export async function runTestGameSchedule(opts: { actor?: string } = {}): Promise<RunSummary> {
  if (running) throw new TestGameError("Lịch Test Game đang chạy — đợi lượt hiện tại xong", 409);
  running = true;
  const today = todayIct();
  const summary: RunSummary = { date: today, at: new Date().toISOString(), campaigns: 0, mails: {}, failed: 0, transitions: [] };
  const count = (code: string, r: string) => {
    if (r === "sent") summary.mails[code] = (summary.mails[code] ?? 0) + 1;
    if (r === "failed") summary.failed++;
  };
  try {
    const settings = await getSettings();
    const campaigns = await prismaApp.testCampaign.findMany({
      where: { status: { in: ["inviting", "testing"] }, noTest: false, startDate: { not: null }, endDate: { not: null }, assignments: { some: {} } },
    });
    for (let c of campaigns) {
      summary.campaigns++;
      const start = isoDate(c.startDate)!;
      const end = isoDate(c.endDate)!;

      const invited = await prismaApp.testAssignment.findMany({ where: { campaignId: c.id, status: "invited" } });
      for (const a of invited) {
        const deadline = responseDeadline(c, a.invitedAt, settings);
        const lateInvite = Boolean(a.invitedAt && ictDateOf(a.invitedAt)! >= start);
        if (today > deadline || (today >= start && !lateInvite)) {
          await prismaApp.testAssignment.update({ where: { id: a.id }, data: { status: "no_response" } });
          continue;
        }
        if (a.invitedAt && today >= addDays(ictDateOf(a.invitedAt)!, settings.remindAfterDays)) count("M2", await sendCampaignMail("M2", c, a));
      }

      if (c.status === "inviting" && today >= start) {
        summary.transitions.push(...(await startDueCampaigns({ id: c.id })));
        c = { ...c, status: "testing" };
      }
      if (c.status !== "testing") continue;

      const inTest = await prismaApp.testAssignment.findMany({ where: { campaignId: c.id, status: "in_test" } });
      if (today <= end) for (const a of inTest) count("M4", await sendCampaignMail("M4", c, a));
      if (today >= addDays(end, -settings.remindBeforeDays) && today < end) {
        for (const a of inTest) count("M5", await sendCampaignMail("M5", c, a));
      }
      if (today === end) {
        const notSubmitted = await prismaApp.testAssignment.findMany({ where: { campaignId: c.id, status: "in_test" } });
        for (const a of notSubmitted) count("M6", await sendCampaignMail("M6", c, a));
      }
      if (today > end) {
        c = await prismaApp.testCampaign.update({ where: { id: c.id }, data: { status: "reporting" } });
        summary.transitions.push(`${c.gameName}: Reporting`);
        await audit(c.id, "system", "campaign.status", { from: "testing", to: "reporting" });
        const joined = await prismaApp.testAssignment.findMany({ where: { campaignId: c.id, status: { in: ["confirmed", "in_test", "submitted"] } } });
        for (const a of joined) count("M7", await sendCampaignMail("M7", c, a));
      }
    }
    await prismaApp.testGameSetting.upsert({
      where: { key: "scheduler" },
      create: { key: "scheduler", value: summary as never, updatedBy: opts.actor ?? "system" },
      update: { value: summary as never, updatedBy: opts.actor ?? "system" },
    });
    if (summary.transitions.length > 0 || Object.keys(summary.mails).length > 0) {
      console.log(`[testgame] schedule ${today}:`, JSON.stringify({ mails: summary.mails, failed: summary.failed, transitions: summary.transitions }));
    }
    return summary;
  } finally {
    running = false;
  }
}

/** Gọi mỗi giờ: chuyển Testing đúng ngày; mail chạy khi tới giờ gửi, hoặc chạy bù nếu hôm nay chưa chạy mà đã qua giờ gửi. */
export async function tickTestGameSchedule(): Promise<void> {
  try {
    await startDueCampaigns();
    const settings = await getSettings();
    if (hourIct() < settings.sendHour) return;
    if ((await lastRunDate()) === todayIct()) return;
    await runTestGameSchedule();
  } catch (err) {
    console.error("[testgame] schedule failed:", (err as Error).message);
  }
}

export async function schedulerStatus() {
  const row = await prismaApp.testGameSetting.findUnique({ where: { key: "scheduler" } });
  return (row?.value as RunSummary | null) ?? null;
}
