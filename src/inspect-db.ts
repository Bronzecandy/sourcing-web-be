import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("=== AppRank sample (1 row) ===");
  const rank = await prisma.appRank.findFirst({
    orderBy: { date: "desc" },
  });
  console.log(JSON.stringify(rank, null, 2));

  console.log("\n=== AppRank count ===");
  const rankCount = await prisma.appRank.count();
  console.log("Total rows:", rankCount);

  console.log("\n=== Distinct dates (last 5) ===");
  const dates = await prisma.appRank.findMany({
    select: { date: true },
    distinct: ["date"],
    orderBy: { date: "desc" },
    take: 5,
  });
  console.log(dates.map((d) => d.date.toISOString().split("T")[0]));

  console.log("\n=== Distinct appIds count ===");
  const apps = await prisma.appRank.findMany({
    select: { appId: true },
    distinct: ["appId"],
  });
  console.log("Unique apps:", apps.length);

  console.log("\n=== AppReview sample (1 row) ===");
  const review = await prisma.appReview.findFirst({
    orderBy: { reviewAt: "desc" },
  });
  console.log(JSON.stringify(review, null, 2));

  console.log("\n=== AppReview count ===");
  const reviewCount = await prisma.appReview.count();
  console.log("Total rows:", reviewCount);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
