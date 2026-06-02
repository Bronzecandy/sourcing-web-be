import crypto from "crypto";
import { LIBRARY_FILES, type LibraryFileId } from "./library-registry";
import {
  applyPendingToLibraryFiles,
  appendCommunityFanRule,
  appendGameSizeRule,
  appendGenreTagKeywords,
  appendKeywordPatternLib,
  appendStudioTierEntryLocal,
  appendUpdateCycleRule,
  type MergePendingBody,
} from "./pending-merge-apply";
import { getLibraryDocument, getLibraryDocumentSync, putLibraryDocument } from "./library-store";
import { prismaApp } from "../utils/prisma-app";

function readStudioForAppend(): {
  version: number;
  neutralScore: number;
  entries: Array<{ names: string[]; score: number; tier?: string; roles?: string[] }>;
} {
  return getLibraryDocumentSync("studio-tiers.json") as {
    version: number;
    neutralScore: number;
    entries: Array<{ names: string[]; score: number; tier?: string; roles?: string[] }>;
  };
}

export function listLibraryFiles(): typeof LIBRARY_FILES {
  return [...LIBRARY_FILES];
}

export async function getLibraryJson(id: string): Promise<unknown> {
  if (id === "pending-additions.json") {
    const items = await listPending();
    return { version: 1, items };
  }
  return getLibraryDocument(id);
}

export async function putLibraryJson(id: string, body: unknown, updatedBy?: string): Promise<void> {
  if (typeof body !== "object" || body === null) throw new Error("Body must be a JSON object");
  if (id === "pending-additions.json") {
    throw new Error("Use pending API instead of writing pending-additions.json");
  }
  await putLibraryDocument(id, body, updatedBy);
}

export interface PendingItem {
  id: string;
  type: string;
  label: string;
  detailVi: string;
  jsonSuggestion: Record<string, unknown>;
  appId: number;
  gameName: string;
  createdAt: string;
  status: "pending" | "merged";
}

function norm(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}

export async function appendPendingBatch(
  items: Omit<PendingItem, "id" | "createdAt" | "status">[],
): Promise<void> {
  if (items.length === 0) return;
  const pending = await prismaApp.libraryPending.findMany({ where: { status: "pending" } });
  const seen = new Set(pending.map((x) => `${x.type}:${norm(x.label)}`));
  for (const it of items) {
    const key = `${it.type}:${norm(it.label)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await prismaApp.libraryPending.create({
      data: {
        id: crypto.randomUUID(),
        type: it.type,
        label: it.label,
        detailVi: it.detailVi,
        jsonSuggestion: it.jsonSuggestion as object,
        appId: it.appId,
        gameName: it.gameName,
        status: "pending",
      },
    });
  }
}

export async function listPending(): Promise<PendingItem[]> {
  const rows = await prismaApp.libraryPending.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    label: r.label,
    detailVi: r.detailVi,
    jsonSuggestion: r.jsonSuggestion as Record<string, unknown>,
    appId: r.appId,
    gameName: r.gameName,
    createdAt: r.createdAt.toISOString(),
    status: r.status as "pending" | "merged",
  }));
}

export async function resolvePending(id: string): Promise<boolean> {
  const row = await prismaApp.libraryPending.findUnique({ where: { id } });
  if (!row) return false;
  await prismaApp.libraryPending.update({ where: { id }, data: { status: "merged" } });
  return true;
}

export async function deletePending(id: string): Promise<boolean> {
  try {
    await prismaApp.libraryPending.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

export async function appendStudioTierEntry(
  input: { names: string[]; score: number; tier?: string; roles?: string[] },
  updatedBy?: string,
): Promise<void> {
  const names = input.names.map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("names required");
  if (!Number.isFinite(input.score)) throw new Error("score must be a number");
  await appendStudioTierEntryLocal(
    {
      names,
      score: input.score,
      tier: input.tier,
    },
    updatedBy,
  );
}

function splitKeywords(s: string): string[] {
  return s
    .split(/[,，、]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Append one row via API — persists immediately without full-document PUT. */
export async function appendLibraryEntry(
  fileId: LibraryFileId,
  body: Record<string, unknown>,
  updatedBy?: string,
): Promise<void> {
  if (fileId === "pending-additions.json") {
    throw new Error("Use pending API for pending additions");
  }

  switch (fileId) {
    case "studio-tiers.json": {
      const rawNames = body.names;
      const names = Array.isArray(rawNames)
        ? rawNames.map(String)
        : typeof body.name === "string"
          ? [body.name]
          : [];
      const score = typeof body.score === "number" ? body.score : Number(body.score);
      if (!Number.isFinite(score)) throw new Error("score is required");
      const roles =
        typeof body.roles === "string"
          ? body.roles.split(/[,，、]/).map((r) => r.trim()).filter(Boolean)
          : Array.isArray(body.roles)
            ? body.roles.map(String)
            : undefined;
      await appendStudioTierEntryLocal(
        {
          names,
          score,
          tier: typeof body.tier === "string" ? body.tier : undefined,
          roles,
        },
        updatedBy,
      );
      return;
    }
    case "genre-tiers.json": {
      const tier = typeof body.tier === "string" ? body.tier.trim() : "";
      if (!tier) throw new Error("tier is required");
      const kw = splitKeywords(
        typeof body.keywords === "string"
          ? body.keywords
          : typeof body.keyword === "string"
            ? body.keyword
            : "",
      );
      if (kw.length === 0) throw new Error("keyword or keywords is required");
      await appendGenreTagKeywords(kw, tier, updatedBy);
      return;
    }
    case "ip-theme-tiers.json":
    case "system-requirement-tiers.json":
    case "art-style-keywords.json": {
      const score = typeof body.score === "number" ? body.score : Number(body.score);
      if (!Number.isFinite(score)) throw new Error("score is required");
      const kw = splitKeywords(
        typeof body.keywords === "string"
          ? body.keywords
          : typeof body.keyword === "string"
            ? body.keyword
            : "",
      );
      if (kw.length === 0) throw new Error("keyword or keywords is required");
      await appendKeywordPatternLib(fileId, kw, score, updatedBy);
      return;
    }
    case "game-size-tiers.json": {
      const maxMb = typeof body.maxMb === "number" ? body.maxMb : Number(body.maxMb);
      const score = typeof body.score === "number" ? body.score : Number(body.score);
      if (!Number.isFinite(maxMb)) throw new Error("maxMb is required");
      if (!Number.isFinite(score)) throw new Error("score is required");
      const label = typeof body.label === "string" ? body.label : `≤${maxMb} MB`;
      await appendGameSizeRule(maxMb, score, label, updatedBy);
      return;
    }
    case "update-cycle-tiers.json": {
      const maxDays =
        typeof body.maxDaysSinceUpdate === "number"
          ? body.maxDaysSinceUpdate
          : Number(body.maxDaysSinceUpdate);
      const score = typeof body.score === "number" ? body.score : Number(body.score);
      if (!Number.isFinite(maxDays)) throw new Error("maxDaysSinceUpdate is required");
      if (!Number.isFinite(score)) throw new Error("score is required");
      const label = typeof body.label === "string" ? body.label : `≤${maxDays}d`;
      await appendUpdateCycleRule(maxDays, score, label, updatedBy);
      return;
    }
    case "community-size-tiers.json": {
      const minFans = typeof body.minFans === "number" ? body.minFans : Number(body.minFans);
      const score = typeof body.score === "number" ? body.score : Number(body.score);
      if (!Number.isFinite(minFans)) throw new Error("minFans is required");
      if (!Number.isFinite(score)) throw new Error("score is required");
      await appendCommunityFanRule(minFans, score, updatedBy);
      return;
    }
    default:
      throw new Error(`Append not supported for ${fileId}`);
  }
}

export function isLibraryFileId(id: string): id is LibraryFileId {
  return (LIBRARY_FILES as readonly string[]).includes(id);
}

export async function mergePendingIntoLibrary(
  id: string,
  body: MergePendingBody,
  updatedBy?: string,
): Promise<void> {
  const row = await prismaApp.libraryPending.findUnique({ where: { id } });
  if (!row || row.status !== "pending") throw new Error("Pending not found or already merged");
  await applyPendingToLibraryFiles(
    { type: row.type, label: row.label, jsonSuggestion: row.jsonSuggestion as Record<string, unknown> },
    body,
    updatedBy,
  );
  await prismaApp.libraryPending.update({ where: { id }, data: { status: "merged" } });
}
