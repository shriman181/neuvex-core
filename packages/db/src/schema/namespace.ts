import { pgSchema } from "drizzle-orm/pg-core";

/**
 * The Postgres schema that holds every Neuvex control-plane table.
 *
 * It was created by hand in the Neon SQL Editor together with the database roles
 * (see README, "One-time database setup"), so migrations never create or drop it.
 * Keep this object out of the files drizzle.config.ts points at.
 */
export const control = pgSchema("control");
