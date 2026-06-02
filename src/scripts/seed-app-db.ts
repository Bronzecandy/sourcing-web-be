import "../load-env";
import fs from "fs";
import path from "path";
import { prismaApp } from "../utils/prisma-app";
import { LIBRARY_FILES } from "../services/library-registry";
import { warmLibraryCache } from "../services/library-store";
import { PERMISSION_KEYS } from "../types/auth";
import { grantAllPermissions } from "../services/auth.service";

const librariesDir = path.join(process.cwd(), "data", "libraries");

async function main() {
  if (!process.env.DATABASE_URL_APP) {
    throw new Error("DATABASE_URL_APP is required");
  }

  console.log("[seed-app] Importing library documents...");
  for (const file of LIBRARY_FILES) {
    if (file === "pending-additions.json") continue;
    const filePath = path.join(librariesDir, file);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8")) as object;
    await prismaApp.libraryDocument.upsert({
      where: { slug: file },
      create: { slug: file, content, version: 1 },
      update: { content, version: { increment: 1 } },
    });
    console.log(`  ✓ ${file}`);
  }

  const manifestPath = path.join(process.cwd(), "data", "rubric", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as object;
  await prismaApp.rubricManifest.upsert({
    where: { id: 1 },
    create: { id: 1, content: manifest, version: (manifest as { version?: number }).version ?? 1 },
    update: { content: manifest, version: (manifest as { version?: number }).version ?? 1 },
  });
  console.log("[seed-app] ✓ rubric manifest");

  const pendingPath = path.join(librariesDir, "pending-additions.json");
  const pendingFile = JSON.parse(fs.readFileSync(pendingPath, "utf-8")) as {
    items?: Array<{
      id: string;
      type: string;
      label: string;
      detailVi: string;
      jsonSuggestion: object;
      appId: number;
      gameName: string;
      createdAt: string;
      status: string;
    }>;
  };
  const items = pendingFile.items ?? [];
  await prismaApp.libraryPending.deleteMany();
  if (items.length > 0) {
    await prismaApp.libraryPending.createMany({
      data: items.map((it) => ({
        id: it.id,
        type: it.type,
        label: it.label,
        detailVi: it.detailVi,
        jsonSuggestion: it.jsonSuggestion,
        appId: it.appId,
        gameName: it.gameName,
        status: it.status,
        createdAt: new Date(it.createdAt),
      })),
    });
  }
  console.log(`[seed-app] ✓ ${items.length} pending rows`);

  const bootstrapEmail = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  if (bootstrapEmail) {
    const existing = await prismaApp.user.findUnique({ where: { email: bootstrapEmail } });
    if (!existing) {
      const user = await prismaApp.user.create({
        data: {
          googleSub: `bootstrap:${bootstrapEmail}`,
          email: bootstrapEmail,
          name: "Bootstrap Admin",
          status: "ACTIVE",
          role: "SUPER_ADMIN",
        },
      });
      for (const permissionKey of PERMISSION_KEYS) {
        await prismaApp.userPermission.create({
          data: { userId: user.id, permissionKey, granted: true },
        });
      }
      console.log(`[seed-app] ✓ bootstrap admin placeholder for ${bootstrapEmail} (link on first Google login)`);
    } else {
      await prismaApp.user.update({
        where: { id: existing.id },
        data: { role: "SUPER_ADMIN", status: "ACTIVE" },
      });
      await grantAllPermissions(existing.id);
      console.log(`[seed-app] ✓ ensured admin for ${bootstrapEmail}`);
    }
  }

  await warmLibraryCache();
  console.log("[seed-app] Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prismaApp.$disconnect());
