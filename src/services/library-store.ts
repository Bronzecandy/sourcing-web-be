import { prismaApp } from "../utils/prisma-app";
import { LIBRARY_FILES, type LibraryFileId } from "./library-registry";
import type { RubricManifest } from "./rubric-manifest";

const DOCUMENT_SLUGS = LIBRARY_FILES.filter((f) => f !== "pending-additions.json") as Exclude<
  LibraryFileId,
  "pending-additions.json"
>[];

const docCache = new Map<string, unknown>();
let manifestCache: RubricManifest | null = null;

export function isDocumentSlug(slug: string): slug is Exclude<LibraryFileId, "pending-additions.json"> {
  return (DOCUMENT_SLUGS as readonly string[]).includes(slug);
}

export async function warmLibraryCache(): Promise<void> {
  const [docs, manifest] = await Promise.all([
    prismaApp.libraryDocument.findMany(),
    prismaApp.rubricManifest.findUnique({ where: { id: 1 } }),
  ]);
  docCache.clear();
  for (const d of docs) {
    docCache.set(d.slug, d.content as unknown);
  }
  manifestCache = manifest ? (manifest.content as unknown as RubricManifest) : null;
}

export function invalidateManifestCache(): void {
  manifestCache = null;
}

/** Sync read — call warmLibraryCache() at startup first. */
export function getLibraryDocumentSync(slug: string): unknown {
  const v = docCache.get(slug);
  if (v === undefined) {
    throw new Error(`Library document not loaded: ${slug}. Run seed:app and warmLibraryCache().`);
  }
  return v;
}

export async function getLibraryDocument(slug: string): Promise<unknown> {
  if (docCache.has(slug)) return docCache.get(slug)!;
  const row = await prismaApp.libraryDocument.findUnique({ where: { slug } });
  if (!row) throw new Error(`Unknown library document: ${slug}`);
  docCache.set(slug, row.content as unknown);
  return row.content as unknown;
}

export async function putLibraryDocument(
  slug: string,
  content: unknown,
  updatedBy?: string,
): Promise<void> {
  if (!isDocumentSlug(slug)) {
    throw new Error(`Not a library document slug: ${slug}`);
  }
  const row = await prismaApp.libraryDocument.upsert({
    where: { slug },
    create: {
      slug,
      content: content as object,
      version: 1,
      updatedBy: updatedBy ?? null,
    },
    update: {
      content: content as object,
      version: { increment: 1 },
      updatedBy: updatedBy ?? null,
    },
  });
  docCache.set(slug, row.content as unknown);
}

export function getRubricManifestSync(): RubricManifest {
  if (!manifestCache) {
    throw new Error("Rubric manifest not loaded. Run seed:app and warmLibraryCache().");
  }
  return manifestCache;
}

export async function getRubricManifest(): Promise<RubricManifest> {
  if (manifestCache) return manifestCache;
  const row = await prismaApp.rubricManifest.findUnique({ where: { id: 1 } });
  if (!row) throw new Error("Rubric manifest missing in app DB");
  manifestCache = row.content as unknown as RubricManifest;
  return manifestCache;
}

export async function putRubricManifest(content: RubricManifest): Promise<void> {
  await prismaApp.rubricManifest.upsert({
    where: { id: 1 },
    create: { id: 1, content: content as object, version: content.version ?? 1 },
    update: { content: content as object, version: content.version ?? 1 },
  });
  manifestCache = content;
}
