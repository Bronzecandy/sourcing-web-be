import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "app.schema.prisma",
  migrations: {
    path: "migrations-app",
  },
  datasource: {
    url: process.env["DATABASE_URL_APP"],
  },
});
