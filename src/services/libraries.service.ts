import fs from "fs";
import crypto from "crypto";
import { LIBRARY_FILES, libraryFilePath, type LibraryFileId } from "./library-registry";
import { applyPendingToLibraryFiles, type MergePendingBody } from "./pending-merge-apply";
function readStudioForAppend(): { version: number; neutralScore: number; entries: Array<{ names: string[]; score: number; tier?: string; roles?: string[] }> } {
  return readRaw("studio-tiers.json") as {
    version: number;
    neutralScore: number;
    entries: Array<{ names: string[]; score: number; tier?: string; roles?: string[] }>;
  };
}

function readRaw(id: string): unknown {
  const text = fs.readFileSync(libraryFilePath(id), "utf-8");
  return JSON.parse(text) as unknown;
}

function writeRaw(id: string, data: unknown): void {
  const p = libraryFilePath(id);
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export function listLibraryFiles(): typeof LIBRARY_FILES {
  return [...LIBRARY_FILES];
}

export function getLibraryJson(id: string): unknown {
  return readRaw(id);
}

export function putLibraryJson(id: string, body: unknown): void {
  if (typeof body !== "object" || body === null) throw new Error("Body must be a JSON object");
  writeRaw(id, body);
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

interface PendingFile {
  version: number;
  items: PendingItem[];
}

function readPendingFile(): PendingFile {
  const raw = readRaw("pending-additions.json") as PendingFile;
  if (!raw.items) raw.items = [];
  return raw;
}

/** Append pending rows (dedupe by type+normalized label). */
export function appendPendingBatch(items: Omit<PendingItem, "id" | "createdAt" | "status">[]): void {
  if (items.length === 0) return;
  const file = readPendingFile();
  const seen = new Set(file.items.filter((x) => x.status === "pending").map((x) => `${x.type}:${norm(x.label)}`));
  for (const it of items) {
    const key = `${it.type}:${norm(it.label)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    file.items.push({
      ...it,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: "pending",
    });
  }
  writeRaw("pending-additions.json", file);
}

function norm(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}

export function listPending(): PendingItem[] {
  return readPendingFile().items.filter((x) => x.status === "pending");
}

export function resolvePending(id: string): boolean {
  const file = readPendingFile();
  const idx = file.items.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  file.items[idx]!.status = "merged";
  writeRaw("pending-additions.json", file);
  return true;
}

export function deletePending(id: string): boolean {
  const file = readPendingFile();
  const before = file.items.length;
  file.items = file.items.filter((x) => x.id !== id);
  if (file.items.length === before) return false;
  writeRaw("pending-additions.json", file);
  return true;
}

/** Thêm entry developer/publisher vào studio-tiers.json (chỉ cần chỉnh score sau). */
export function appendStudioTierEntry(input: { names: string[]; score: number; tier?: string }): void {
  const names = input.names.map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("names required");
  const data = readStudioForAppend();
  if (!data.entries) data.entries = [];
  data.entries.push({
    names,
    score: input.score,
    tier: input.tier ?? "custom",
    roles: ["developer"],
  });
  writeRaw("studio-tiers.json", data);
}

export function isLibraryFileId(id: string): id is LibraryFileId {
  return (LIBRARY_FILES as readonly string[]).includes(id);
}

export function mergePendingIntoLibrary(id: string, body: MergePendingBody): void {
  const file = readPendingFile();
  const idx = file.items.findIndex((x) => x.id === id && x.status === "pending");
  if (idx < 0) throw new Error("Pending not found or already merged");
  const item = file.items[idx]!;
  applyPendingToLibraryFiles(
    { type: item.type, label: item.label, jsonSuggestion: item.jsonSuggestion as Record<string, unknown> },
    body,
  );
  file.items[idx]!.status = "merged";
  writeRaw("pending-additions.json", file);
}
