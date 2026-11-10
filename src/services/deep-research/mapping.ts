import { Prisma, type GameMarketMapping } from "../../../generated/prisma-app/client";
import { isUnifiedId, marketDataConfigured } from "../../utils/market-data";
import { prismaApp } from "../../utils/prisma-app";
import { bestSimilarity, hasCjk, nameSimilarity, titleVariants } from "./similarity";
import { addMonths, lastFullMonth, stByExactNames, stByStoreIds, stGameInfos, stMonthSnapshots, stNameSearch } from "./st-data";
import { steamByExactNames, steamInfos, steamLatestReviews, steamNameSearch, steamRefOf } from "./steam-data";
import { loadTapTapFacts, type TapTapFacts } from "./taptap";
import type { Candidates, GameIdentity, MapStatus, MappingDto, StCandidate, StRef, SteamCandidate, SteamRef } from "./types";
import { researchIdentity } from "./web";

export class DeepResearchError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const RECHECK_MS = 3 * 86_400_000;
const IDENTITY_TTL_MS = 30 * 86_400_000;

const json = (v: unknown) => v as Prisma.InputJsonValue;

export function stRefOf(info: StRef): StRef {
  const { unifiedId, name, publisher, iconUrl, gameClass, genre, subgenre, releaseDate } = info;
  return { unifiedId, name, publisher, iconUrl, gameClass, genre, subgenre, releaseDate };
}

export function mappingDto(row: GameMarketMapping | null, appId: number, title: string): MappingDto {
  return {
    appId,
    title: row?.title ?? title,
    st: { status: (row?.stStatus as MapStatus) ?? "unmapped", method: row?.stMethod ?? null, ref: (row?.stRef as StRef | null) ?? null },
    steam: { status: (row?.steamStatus as MapStatus) ?? "unmapped", method: row?.steamMethod ?? null, ref: (row?.steamRef as SteamRef | null) ?? null },
    identity: (row?.identity as GameIdentity | null) ?? null,
    confirmedBy: row?.confirmedBy ?? null,
    confirmedAt: row?.confirmedAt?.toISOString() ?? null,
    checkedAt: row?.checkedAt?.toISOString() ?? null,
  };
}

export function isDecided(status: string | undefined): boolean {
  return status === "auto" || status === "confirmed" || status === "none";
}

/**
 * Cheap mapping for many apps: TapTap iTunes id / Android package → Sensor Tower, then a unique exact
 * Chinese-name match, then Steam by the Sensor Tower English name. Never overrides confirmed/none choices.
 */
export async function autoMapBatch(facts: TapTapFacts[]): Promise<void> {
  if (!facts.length || !marketDataConfigured()) return;
  const existing = new Map((await prismaApp.gameMarketMapping.findMany({ where: { appId: { in: facts.map((f) => f.appId) } } })).map((r) => [r.appId, r]));
  const pending = facts.filter((f) => !isDecided(existing.get(f.appId)?.stStatus));

  const st = new Map<number, { uid: string; method: string }>();
  if (pending.length) {
    const byStore = await stByStoreIds(
      pending.map((f) => f.itunesId).filter((v): v is string => Boolean(v)),
      pending.map((f) => f.androidPackage).filter((v): v is string => Boolean(v)),
    );
    for (const f of pending) {
      const viaItunes = f.itunesId ? byStore.get(f.itunesId) : undefined;
      const viaPackage = f.androidPackage ? byStore.get(f.androidPackage) : undefined;
      if (viaItunes) st.set(f.appId, { uid: viaItunes, method: "itunes_id" });
      else if (viaPackage) st.set(f.appId, { uid: viaPackage, method: "android_package" });
    }
    const byName = await stByExactNames(pending.filter((f) => !st.has(f.appId)).map((f) => f.title));
    for (const f of pending) {
      if (st.has(f.appId)) continue;
      const hits = byName.get(f.title);
      if (hits?.size === 1) st.set(f.appId, { uid: [...hits][0], method: "name_exact" });
    }
  }

  const infos = await stGameInfos([...st.values()].map((v) => v.uid));
  const stNameFor = (appId: number): string | null => {
    const row = existing.get(appId);
    if (row?.stStatus === "auto" || row?.stStatus === "confirmed") return row.stName;
    const hit = st.get(appId);
    return hit ? (infos.get(hit.uid)?.name ?? null) : null;
  };
  const steamPending = facts.filter((f) => !isDecided(existing.get(f.appId)?.steamStatus));
  const steamNames = steamPending.map((f) => stNameFor(f.appId)).filter((n): n is string => Boolean(n) && !hasCjk(n!));
  const steamHits = steamNames.length ? await steamByExactNames(steamNames) : new Map<string, number[]>();
  const steamIds = new Map<number, number>();
  for (const f of steamPending) {
    const ids = steamHits.get(stNameFor(f.appId)?.toLowerCase() ?? "");
    if (ids?.length === 1) steamIds.set(f.appId, ids[0]);
  }
  const steamInfo = await steamInfos([...steamIds.values()]);

  const now = new Date();
  for (const f of facts) {
    const row = existing.get(f.appId);
    const stHit = st.get(f.appId);
    const stInfo = stHit ? infos.get(stHit.uid) : undefined;
    const steamId = steamIds.get(f.appId);
    const steam = steamId ? steamInfo.get(steamId) : undefined;
    const data: Prisma.GameMarketMappingUncheckedCreateInput = {
      appId: f.appId,
      title: f.title,
      checkedAt: now,
      ...(stInfo && !isDecided(row?.stStatus)
        ? { stStatus: "auto", stUnifiedId: stInfo.unifiedId, stName: stInfo.name, stMethod: stHit!.method, stRef: json(stRefOf(stInfo)) }
        : {}),
      ...(steam && !isDecided(row?.steamStatus)
        ? { steamStatus: "auto", steamAppId: steam.steamAppId, steamName: steam.name, steamMethod: "st_name_exact", steamRef: json(steamRefOf(steam)) }
        : {}),
    };
    await prismaApp.gameMarketMapping.upsert({ where: { appId: f.appId }, create: data, update: { ...data, appId: undefined } });
  }
}

/** Mappings for these apps; auto-maps rows never checked or still unmapped after RECHECK_MS. */
export async function ensureMappings(appIds: number[]): Promise<Map<number, GameMarketMapping>> {
  const rows = await prismaApp.gameMarketMapping.findMany({ where: { appId: { in: appIds } } });
  const byId = new Map(rows.map((r) => [r.appId, r]));
  const stale = appIds.filter((id) => {
    const r = byId.get(id);
    return !r || (r.stStatus === "unmapped" && Date.now() - r.checkedAt.getTime() > RECHECK_MS);
  });
  if (stale.length && marketDataConfigured()) {
    const facts = await loadTapTapFacts(stale);
    await autoMapBatch([...facts.values()]);
    for (const r of await prismaApp.gameMarketMapping.findMany({ where: { appId: { in: stale } } })) byId.set(r.appId, r);
  }
  return byId;
}

export async function ensureIdentity(facts: TapTapFacts, force = false): Promise<GameIdentity | null> {
  const row = await prismaApp.gameMarketMapping.findUnique({ where: { appId: facts.appId } });
  if (!force && row?.identity && row.identityAt && Date.now() - row.identityAt.getTime() < IDENTITY_TTL_MS) return row.identity as unknown as GameIdentity;
  const identity = await researchIdentity(facts);
  await prismaApp.gameMarketMapping.upsert({
    where: { appId: facts.appId },
    create: { appId: facts.appId, title: facts.title, identity: json(identity), identityAt: new Date() },
    update: { identity: json(identity), identityAt: new Date() },
  });
  return identity;
}

function companyNames(facts: TapTapFacts, identity: GameIdentity | null): string[] {
  return [...facts.developers.map((d) => d.name), identity?.developerEn, identity?.publisherEn].filter((v): v is string => Boolean(v));
}

function nearDate(a: string | null, b: string | null, days: number): boolean {
  if (!a || !b) return false;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= days * 86_400_000;
}

/** Sensor Tower + Steam candidates ranked by name, company and release-date agreement. */
export async function searchCandidates(facts: TapTapFacts, identity: GameIdentity | null, extra: string[] = []): Promise<Candidates> {
  const intl = [...(identity?.internationalNames ?? []), ...(identity?.otherNames ?? [])];
  const queries = [...new Set([...extra, ...titleVariants(facts.title), ...intl].map((q) => q.trim()).filter((q) => q.length >= 2))];
  const companies = companyNames(facts, identity);

  const stHits = await stNameSearch(queries);
  const stIds = [...stHits.keys()].slice(0, 40);
  const month = lastFullMonth();
  const [infos, snaps] = await Promise.all([stGameInfos(stIds), stMonthSnapshots(stIds, [month])]);
  const st: StCandidate[] = [];
  for (const uid of stIds) {
    const info = infos.get(uid);
    if (!info) continue;
    const names = [info.name, ...(stHits.get(uid) ?? [])];
    const name = bestSimilarity(queries, names);
    const company = info.publisher ? Math.max(0, ...companies.map((c) => nameSimilarity(c, info.publisher!))) : 0;
    const date = nearDate(facts.releaseDate, info.releaseDate, 90);
    const reasons: string[] = [];
    if (name.score >= 0.99) reasons.push(`Trùng tên: ${name.name}`);
    else if (name.score >= 0.6) reasons.push(`Tên gần giống: ${name.name}`);
    if (intl.some((n) => nameSimilarity(n, info.name) >= 0.99)) reasons.push("Khớp tên quốc tế tìm được trên web");
    if (company >= 0.5) reasons.push(`Cùng nhà phát hành: ${info.publisher}`);
    if (date) reasons.push("Ngày ra mắt gần với TapTap");
    const rows = snaps.get(uid) ?? [];
    const last = rows.find((r) => r.country === "CN" && (r.avgDau || r.revenueUsd)) ?? rows.find((r) => r.country === "WW") ?? null;
    st.push({
      ...stRefOf(info),
      score: Math.round((0.75 * name.score + 0.15 * Math.min(1, company) + (date ? 0.1 : 0)) * 100) / 100,
      reasons,
      lastMonth: last,
    });
  }
  st.sort((a, b) => b.score - a.score || (b.lastMonth?.revenueUsd ?? 0) - (a.lastMonth?.revenueUsd ?? 0));

  const steamQueries = [...new Set([...extra.filter((q) => !hasCjk(q)), ...intl.filter((q) => !hasCjk(q)), ...st.slice(0, 2).map((c) => c.name).filter((n) => !hasCjk(n))])];
  const steamIds = new Set(await steamNameSearch(steamQueries));
  if (identity?.steamAppId) steamIds.add(identity.steamAppId);
  const steamList = [...steamIds].slice(0, 30);
  const [sInfos, reviews] = await Promise.all([steamInfos(steamList), steamLatestReviews(steamList)]);
  const steam: SteamCandidate[] = [];
  for (const id of steamList) {
    const info = sInfos.get(id);
    if (!info) continue;
    const name = bestSimilarity(steamQueries.length ? steamQueries : [facts.title], [info.name]);
    const company = Math.max(0, ...companies.flatMap((c) => [...info.developers, ...info.publishers].map((d) => nameSimilarity(c, d))));
    const reasons: string[] = [];
    const fromWeb = identity?.steamAppId === id;
    if (fromWeb) reasons.push("Link Steam tìm được trên web");
    if (name.score >= 0.99) reasons.push(`Trùng tên: ${info.name}`);
    else if (name.score >= 0.6) reasons.push(`Tên gần giống: ${name.query}`);
    if (company >= 0.5) reasons.push("Cùng nhà phát triển/phát hành");
    const rv = reviews.get(id);
    steam.push({
      ...steamRefOf(info),
      score: Math.min(1, Math.round((0.7 * name.score + 0.2 * Math.min(1, company) + (fromWeb ? 0.4 : 0)) * 100) / 100),
      reasons,
      reviews: rv?.total ?? null,
      positivePct: rv?.total && rv.positive != null ? Math.round((rv.positive / rv.total) * 1000) / 10 : null,
    });
  }
  steam.sort((a, b) => b.score - a.score || (b.reviews ?? 0) - (a.reviews ?? 0));

  return { st: st.slice(0, 8), steam: steam.slice(0, 6), searched: queries };
}

export interface MappingChoice {
  st?: { unifiedId: string } | { none: true } | { reset: true };
  steam?: { steamAppId: number } | { none: true } | { reset: true };
}

export async function saveMapping(appId: number, choice: MappingChoice, actor: string): Promise<MappingDto> {
  const facts = (await loadTapTapFacts([appId])).get(appId);
  const title = facts?.title ?? `App #${appId}`;
  const data: Prisma.GameMarketMappingUncheckedCreateInput = { appId, title, confirmedBy: actor, confirmedAt: new Date() };

  if (choice.st && "unifiedId" in choice.st) {
    if (!isUnifiedId(choice.st.unifiedId)) throw new DeepResearchError("unifiedId không hợp lệ");
    const info = (await stGameInfos([choice.st.unifiedId])).get(choice.st.unifiedId);
    if (!info) throw new DeepResearchError("Không tìm thấy game này trên Sensor Tower", 404);
    Object.assign(data, { stStatus: "confirmed", stUnifiedId: info.unifiedId, stName: info.name, stMethod: "manual", stRef: json(stRefOf(info)) });
  } else if (choice.st) {
    const none = "none" in choice.st;
    Object.assign(data, { stStatus: none ? "none" : "unmapped", stUnifiedId: null, stName: null, stMethod: none ? "manual" : null, stRef: Prisma.DbNull });
    if (!none) data.checkedAt = new Date(0);
  }

  if (choice.steam && "steamAppId" in choice.steam) {
    const id = Number(choice.steam.steamAppId);
    const info = Number.isSafeInteger(id) ? (await steamInfos([id])).get(id) : undefined;
    if (!info) throw new DeepResearchError("Không tìm thấy game này trong kho Steam", 404);
    Object.assign(data, { steamStatus: "confirmed", steamAppId: id, steamName: info.name, steamMethod: "manual", steamRef: json(steamRefOf(info)) });
  } else if (choice.steam) {
    const none = "none" in choice.steam;
    Object.assign(data, { steamStatus: none ? "none" : "unmapped", steamAppId: null, steamName: null, steamMethod: none ? "manual" : null, steamRef: Prisma.DbNull });
  }

  const { appId: _id, ...update } = data;
  const row = await prismaApp.gameMarketMapping.upsert({ where: { appId }, create: data, update });
  return mappingDto(row, appId, title);
}

export function lastMonths(): string[] {
  const m = lastFullMonth();
  return [m, addMonths(m, -1)];
}
