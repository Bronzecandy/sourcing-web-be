import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

const connectionString = process.env.DATABASE_URL!;

const poolMax = Math.max(4, parseInt(process.env.PG_POOL_MAX ?? "8", 10) || 8);

export const pool = new pg.Pool({
  connectionString,
  max: poolMax,
  connectionTimeoutMillis: 60_000,
  idleTimeoutMillis: 60_000,
  statement_timeout: 120_000,
  query_timeout: 120_000,
});

const adapter = new PrismaPg(pool);

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
