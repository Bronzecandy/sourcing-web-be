import { Prisma, type DeepResearchRun, type GameMarketMapping } from "../../../generated/prisma-app/client";
import { marketDataConfigured } from "../../utils/market-data";
import { prismaApp } from "../../utils/prisma-app";
import { rankingService } from "../ranking.service";
import { frameworks } from "./frameworks";
import { buildMarketReport, buildSteamReport } from "./market";
import { DeepResearchError, ensureIdentity, ensureMappings, isDecided, mappingDto, searchCandidates } from "./mapping";
import { hasCjk } from "./similarity";
import { stGameInfos } from "./st-data";
import { steamInfos } from "./steam-data";
import { synthesize } from "./synthesis";
import { loadTapTapFact, type TapTapFacts } from "./taptap";
import type {
  Candidates,
  GameIdentity,
  MappingDto,
  MarketReport,
  RunContext,
  RunDto,
  RunListItem,
  RunStatus,
  StageKey,
  StageState,
  SteamReport,
  SynthesisDto,
  TapTapSnapshot,
  Verdict,
  WebReport,
} from "./types";
import { researchWeb } from "./web";

const STAGES: StageKey[] = ["identify", "mapping", "market", "steam", "web", "synthesis"];
const STALE_MS = 20 * 60_000;
const MAX_CONCURRENT = 2;

const json = (v: unknown) => v as Prisma.InputJsonValue;

let active = 0;
const waiting: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function log(message: string): void {
  console.log(`[deep-research] ${message}`);
}

function listItem(r: DeepResearchRun): RunListItem {
  return {
    id: r.id,
    appId: r.appId,
    title: r.title,
    iconUrl: r.iconUrl,
    status: r.status as RunStatus,
    verdict: (r.verdict as Verdict | null) ?? null,
    marketScore: r.marketScore,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

function runDto(r: DeepResearchRun): RunDto {
  return {
    ...listItem(r),
    stage: (r.stage as StageKey | null) ?? null,
    stages: (r.stages as unknown as StageState[] | null) ?? STAGES.map((key) => ({ key, status: "pending", note: null })),
    context: (r.context as unknown as RunContext | null) ?? null,
    error: r.error,
    startedAt: r.startedAt?.toISOString() ?? null,
    taptap: (r.taptap as unknown as TapTapSnapshot | null) ?? null,
    mapping: (r.mapping as unknown as MappingDto | null) ?? null,
    candidates: (r.candidates as unknown as Candidates | null) ?? null,
    market: (r.market as unknown as MarketReport | null) ?? null,
    steam: (r.steam as unknown as SteamReport | null) ?? null,
    web: (r.web as unknown as WebReport | null) ?? null,
    summary: (r.summary as unknown as SynthesisDto | null) ?? null,
  };
}

async function expireIfStale(r: DeepResearchRun): Promise<DeepResearchRun> {
  if ((r.status === "running" || r.status === "queued") && Date.now() - r.updatedAt.getTime() > STALE_MS) {
    return prismaApp.deepResearchRun.update({
      where: { id: r.id },
      data: { status: "failed", error: "Lần chạy bị gián đoạn (máy chủ khởi động lại hoặc quá thời gian). Hãy chạy lại." },
    });
  }
  return r;
}

async function stage(id: string, key: StageKey, status: StageState["status"], note: string | null = null, extra: Prisma.DeepResearchRunUpdateInput = {}) {
  const run = await prismaApp.deepResearchRun.findUniqueOrThrow({ where: { id }, select: { stages: true } });
  const stages = ((run.stages as unknown as StageState[] | null) ?? STAGES.map((k) => ({ key: k, status: "pending" as const, note: null }))).map((s) =>
    s.key === key ? { ...s, status, note } : s,
  );
  await prismaApp.deepResearchRun.update({ where: { id }, data: { ...extra, stage: key, stages: json(stages) } });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function potentialSnapshot(appId: number, ctx: RunContext | null): Promise<TapTapSnapshot["potential"]> {
  const tries: RunContext[] = ctx
    ? [ctx]
    : [
        { days: 14, platform: "combined", segment: "reserve" },
        { days: 14, platform: "combined", segment: "launched" },
      ];
  for (const c of tries) {
    try {
      const list = await withTimeout(rankingService.calculatePotentialScores(c.days, c.platform, c.segment), 25_000);
      const hit = list?.find((s) => s.appId === appId);
      if (hit) {
        return {
          segment: c.segment,
          days: c.days,
          platform: c.platform,
          compositeScore: hit.compositeScore ?? null,
          momentumScore: hit.momentumScore ?? null,
          audienceScore: hit.audienceScore ?? null,
          ratingScore: hit.ratingScore ?? null,
          rankQualityScore: hit.rankQualityScore ?? null,
          currentRank: hit.currentRank ?? null,
          trend: hit.trend ?? null,
          audienceGrowthRate: hit.audienceGrowthRate ?? null,
        };
      }
    } catch (err) {
      log(`potential snapshot ${appId} ${c.segment}: ${(err as Error).message}`);
    }
  }
  return null;
}

function taptapSnapshot(f: TapTapFacts, potential: TapTapSnapshot["potential"]): TapTapSnapshot {
  return {
    title: f.title,
    iconUrl: f.iconUrl,
    developers: f.developers,
    releaseDate: f.releaseDate,
    tags: f.tags,
    rating: f.rating,
    fans: f.fans,
    reserveCount: f.reserveCount,
    downloadCount: f.downloadCount,
    storeIds: { itunes: f.itunesId, android: f.androidPackage },
    potential,
  };
}

async function mappingRow(appId: number): Promise<GameMarketMapping | null> {
  return prismaApp.gameMarketMapping.findUnique({ where: { appId } });
}

async function fail(id: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  log(`run ${id} failed: ${message}`);
  const run = await prismaApp.deepResearchRun.findUnique({ where: { id }, select: { stages: true } }).catch(() => null);
  const stages = ((run?.stages as unknown as StageState[] | null) ?? []).map((s) => (s.status === "running" ? { ...s, status: "failed" as const, note: message.slice(0, 200) } : s));
  await prismaApp.deepResearchRun
    .update({ where: { id }, data: { status: "failed", error: message.slice(0, 500), finishedAt: new Date(), stages: json(stages) } })
    .catch(() => undefined);
}

/** Identity + candidates; stops at needs_mapping while Sensor Tower is undecided. */
async function phaseOne(id: string): Promise<boolean> {
  const run = await prismaApp.deepResearchRun.update({ where: { id }, data: { status: "running", startedAt: new Date() } });
  const facts = await loadTapTapFact(run.appId);
  if (!facts) throw new DeepResearchError("Không tìm thấy dữ liệu TapTap của game này", 404);
  const potential = await potentialSnapshot(run.appId, (run.context as unknown as RunContext | null) ?? null);
  await prismaApp.deepResearchRun.update({ where: { id }, data: { taptap: json(taptapSnapshot(facts, potential)), title: facts.title, iconUrl: facts.iconUrl } });

  await stage(id, "mapping", "running");
  let row = (await ensureMappings([run.appId])).get(run.appId) ?? null;
  const undecided = !isDecided(row?.stStatus) || !isDecided(row?.steamStatus);
  let identity = (row?.identity as unknown as GameIdentity | null) ?? null;
  if (undecided) {
    await stage(id, "identify", "running");
    try {
      identity = await ensureIdentity(facts);
      const names = identity ? [...identity.internationalNames, ...identity.otherNames] : [];
      await stage(id, "identify", "done", names.length ? names.join(", ") : identity?.grounded ? "Không tìm thấy tên quốc tế" : "Web search không hoàn tất");
    } catch (err) {
      await stage(id, "identify", "failed", (err as Error).message.slice(0, 200));
    }
    const candidates = await searchCandidates(facts, identity);
    row = await mappingRow(run.appId);
    const webSteam = identity?.steamAppId ? candidates.steam.find((c) => c.steamAppId === identity!.steamAppId && c.score >= 0.9) : undefined;
    if (webSteam && !isDecided(row?.steamStatus)) {
      row = await prismaApp.gameMarketMapping.update({
        where: { appId: run.appId },
        data: { steamStatus: "auto", steamAppId: webSteam.steamAppId, steamName: webSteam.name, steamMethod: "web_link", steamRef: json({ steamAppId: webSteam.steamAppId, name: webSteam.name, developers: webSteam.developers, publishers: webSteam.publishers, releaseDate: webSteam.releaseDate, headerImage: webSteam.headerImage }) },
      });
    }
    await prismaApp.deepResearchRun.update({ where: { id }, data: { candidates: json(candidates) } });
  } else {
    await stage(id, "identify", "skipped", "Đã ghép đủ Sensor Tower và Steam");
  }

  const dto = mappingDto(row, run.appId, facts.title);
  await prismaApp.deepResearchRun.update({ where: { id }, data: { mapping: json(dto) } });
  if (!isDecided(row?.stStatus)) {
    await stage(id, "mapping", "pending", "Chờ xác nhận game trên Sensor Tower", { status: "needs_mapping" });
    return false;
  }
  await stage(id, "mapping", "done", mappingNote(dto));
  return true;
}

function mappingNote(m: MappingDto): string {
  const st = m.st.status === "none" ? "Không có trên Sensor Tower" : `ST: ${m.st.ref?.name ?? "?"}`;
  const steam = m.steam.status === "none" || m.steam.status === "unmapped" ? "chưa có Steam" : `Steam: ${m.steam.ref?.name ?? "?"}`;
  return `${st}; ${steam}`;
}

function researchNames(facts: TapTapSnapshot | null, identity: GameIdentity | null, market: MarketReport | null, steam: SteamReport | null, title: string) {
  const latin = (n: string | null | undefined) => (n && !hasCjk(n) ? n : null);
  return {
    title: facts?.title ?? title,
    international: identity?.internationalNames[0] ?? latin(market?.name) ?? latin(steam?.ref.name) ?? null,
    developer: identity?.developerEn ?? steam?.ref.developers[0] ?? facts?.developers.find((d) => d.type === "developer")?.name ?? facts?.developers[0]?.name ?? null,
    publisher: identity?.publisherEn ?? market?.publisher ?? facts?.developers.find((d) => d.type === "publisher")?.name ?? null,
  };
}

async function phaseTwo(id: string): Promise<void> {
  const run = await prismaApp.deepResearchRun.update({ where: { id }, data: { status: "running" } });
  const row = await mappingRow(run.appId);
  const facts = (run.taptap as unknown as TapTapSnapshot | null) ?? null;
  const dto = mappingDto(row, run.appId, run.title);
  await prismaApp.deepResearchRun.update({ where: { id }, data: { mapping: json(dto) } });
  const identity = dto.identity;

  let market: MarketReport | null = null;
  if ((dto.st.status === "auto" || dto.st.status === "confirmed") && dto.st.ref) {
    await stage(id, "market", "running");
    try {
      const info = (await stGameInfos([dto.st.ref.unifiedId])).get(dto.st.ref.unifiedId);
      if (!info) throw new Error("Sensor Tower không trả về thông tin game");
      market = await buildMarketReport(info);
      await stage(id, "market", "done", market.marketScore !== null ? `Market score ${market.marketScore}` : "Không có số liệu", { market: json(market), marketScore: market.marketScore });
    } catch (err) {
      await stage(id, "market", "failed", (err as Error).message.slice(0, 200));
    }
  } else {
    await stage(id, "market", "skipped", "Không có trên Sensor Tower");
  }

  let steam: SteamReport | null = null;
  if ((dto.steam.status === "auto" || dto.steam.status === "confirmed") && dto.steam.ref) {
    await stage(id, "steam", "running");
    try {
      const info = (await steamInfos([dto.steam.ref.steamAppId])).get(dto.steam.ref.steamAppId);
      if (!info) throw new Error("Kho Steam không trả về thông tin game");
      steam = await buildSteamReport(info);
      await stage(id, "steam", "done", steam.steamScore !== null ? `Steam score ${steam.steamScore}` : null, { steam: json(steam) });
    } catch (err) {
      await stage(id, "steam", "failed", (err as Error).message.slice(0, 200));
    }
  } else {
    await stage(id, "steam", "skipped", dto.steam.status === "none" ? "Không có trên Steam" : "Chưa ghép Steam");
  }

  await stage(id, "web", "running");
  let web: WebReport | null = null;
  try {
    web = await researchWeb(researchNames(facts, identity, market, steam, run.title));
    await stage(id, "web", web.findings.length ? "done" : "failed", web.findings.length ? `${web.findings.length} finding có nguồn` : web.errors[0] ?? "Không có finding nào có nguồn", { web: json(web) });
  } catch (err) {
    await stage(id, "web", "failed", (err as Error).message.slice(0, 200));
  }

  await stage(id, "synthesis", "running");
  const summary = await synthesize(facts, market, steam, web, dto);
  await stage(id, "synthesis", "done", null, { summary: json(summary), verdict: summary.verdict, status: "done", finishedAt: new Date() });
  log(`run ${id} done: ${run.title} verdict=${summary.verdict} market=${market?.marketScore ?? "n/a"}`);
}

function background(id: string, fn: (id: string) => Promise<unknown>): void {
  void withSlot(async () => {
    try {
      await fn(id);
    } catch (err) {
      await fail(id, err);
    }
  });
}

export interface Actor {
  id: string;
  name: string | null;
  email: string;
}

export async function startRun(appId: number, ctx: RunContext | null, actor: Actor): Promise<RunDto> {
  if (!marketDataConfigured()) throw new DeepResearchError("Chưa cấu hình MARKET_DATA_API_KEY trên máy chủ", 503);
  const existing = await prismaApp.deepResearchRun.findFirst({ where: { appId, status: { in: ["queued", "running"] } }, orderBy: { createdAt: "desc" } });
  if (existing && (await expireIfStale(existing)).status !== "failed") return runDto(existing);
  const facts = await loadTapTapFact(appId);
  if (!facts) throw new DeepResearchError("Không tìm thấy game TapTap này (không có trong dữ liệu crawl 45 ngày gần nhất)", 404);
  const run = await prismaApp.deepResearchRun.create({
    data: {
      appId,
      title: facts.title,
      iconUrl: facts.iconUrl,
      status: "queued",
      stages: json(STAGES.map((key) => ({ key, status: "pending", note: null }))),
      context: ctx ? json(ctx) : Prisma.DbNull,
      createdById: actor.id,
      createdByName: actor.name || actor.email,
    },
  });
  log(`run ${run.id} started by ${actor.email}: ${facts.title} (${appId})`);
  background(run.id, async (id) => {
    if (await phaseOne(id)) await phaseTwo(id);
  });
  return runDto(run);
}

export async function continueRun(id: string): Promise<RunDto> {
  const run = await prismaApp.deepResearchRun.findUnique({ where: { id } });
  if (!run) throw new DeepResearchError("Không tìm thấy lần chạy", 404);
  if (run.status !== "needs_mapping") throw new DeepResearchError("Lần chạy này không ở bước chờ xác nhận mapping", 409);
  const row = await mappingRow(run.appId);
  if (!isDecided(row?.stStatus)) throw new DeepResearchError("Hãy chọn game trên Sensor Tower hoặc đánh dấu 'Không có trên Sensor Tower'", 409);
  await stage(id, "mapping", "done", mappingNote(mappingDto(row, run.appId, run.title)), { status: "queued" });
  background(id, phaseTwo);
  return runDto(await prismaApp.deepResearchRun.findUniqueOrThrow({ where: { id } }));
}

export async function getRun(id: string): Promise<RunDto> {
  const run = await prismaApp.deepResearchRun.findUnique({ where: { id } });
  if (!run) throw new DeepResearchError("Không tìm thấy lần chạy", 404);
  return runDto(await expireIfStale(run));
}

export async function listRuns(limit: number): Promise<RunListItem[]> {
  const rows = await prismaApp.deepResearchRun.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(200, Math.max(1, limit)) });
  return rows.map(listItem);
}

export async function appOverview(appId: number) {
  const facts = await loadTapTapFact(appId);
  const row = (await ensureMappings([appId])).get(appId) ?? null;
  const runs = await prismaApp.deepResearchRun.findMany({ where: { appId }, orderBy: { createdAt: "desc" }, take: 30 });
  const latest = runs[0] ? await expireIfStale(runs[0]) : null;
  return {
    appId,
    title: facts?.title ?? row?.title ?? `App #${appId}`,
    iconUrl: facts?.iconUrl ?? null,
    developers: facts?.developers ?? [],
    releaseDate: facts?.releaseDate ?? null,
    mapping: mappingDto(row, appId, facts?.title ?? `App #${appId}`),
    runs: runs.map((r) => (latest && r.id === latest.id ? listItem(latest) : listItem(r))),
    latest: latest ? runDto(latest) : null,
  };
}

export async function candidatesFor(appId: number, query: string | null): Promise<Candidates> {
  const facts = await loadTapTapFact(appId);
  if (!facts) throw new DeepResearchError("Không tìm thấy game TapTap này", 404);
  const row = await mappingRow(appId);
  const identity = (row?.identity as unknown as GameIdentity | null) ?? null;
  return searchCandidates(facts, identity, query ? [query.slice(0, 80)] : []);
}

export function frameworksDto() {
  const f = frameworks();
  return { version: f.version, metrics: f.metrics, patterns: f.patterns };
}
