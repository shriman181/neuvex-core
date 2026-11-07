-- Baseline for the Neuvex control plane.
--
-- The `control` schema and the neuvex_migrator / waitlist_writer roles were created
-- by hand in the Neon SQL Editor on 7 November 2026 (see README). This migration
-- records that starting point and is safe to run on any branch that already has it.
CREATE SCHEMA IF NOT EXISTS "control";
