import { defineConfig } from "drizzle-kit";

// DATABASE_URL is only needed for `migrate`. `generate` and `check` work offline.
// CI sets it to the neuvex_migrator role: a preview branch for pull requests,
// production after a merge to main.
const url = process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  // Only table files are listed here. The `control` pgSchema object is defined in
  // src/schema/namespace.ts and deliberately not exported from tables.ts, so
  // drizzle-kit never emits CREATE SCHEMA for a schema that already exists.
  schema: "./src/schema/tables.ts",
  out: "./migrations",
  // This package owns the `control` schema only. public.waitlist is managed by hand.
  schemaFilter: ["control"],
  migrations: {
    schema: "drizzle",
    table: "__drizzle_migrations",
  },
  strict: true,
  verbose: true,
  ...(url ? { dbCredentials: { url } } : {}),
});
