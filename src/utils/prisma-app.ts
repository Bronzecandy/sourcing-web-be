import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma-app/client";

const connectionString = process.env.DATABASE_URL_APP?.trim();
if (!connectionString) {
  throw new Error("DATABASE_URL_APP is required for app database (auth, libraries)");
}

const pool = new pg.Pool({
  connectionString,
  max: 10,
  connectionTimeoutMillis: 30_000,
});

const adapter = new PrismaPg(pool);

const globalForPrisma = globalThis as unknown as {
  prismaApp: PrismaClient | undefined;
};

export const prismaApp =
  globalForPrisma.prismaApp ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaApp = prismaApp;
}
