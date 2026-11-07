-- Phase 2: the audit log, and exactly the access the gateway needs.
--
-- Requires two things done by hand in the Neon SQL Editor on production on
-- 7 November 2026 (see README): the neuvex_gateway role, and
--   GRANT USAGE ON SCHEMA control TO neuvex_migrator WITH GRANT OPTION;
-- so this migration can pass schema access on to the gateway. The check at the end
-- fails the migration loudly if either is missing. Every SECURITY DEFINER function below
-- runs as its owner, neuvex_migrator, has a fixed search_path, and is closed to
-- PUBLIC; only the grants at the end open them up.

-- Vendor key lookup -------------------------------------------------------------
-- The gateway has to find a key's vendor before it knows which vendor it acts for,
-- so this one lookup runs with the owner's rights instead of under row-level
-- security. It returns only keys that have not been revoked.
CREATE FUNCTION "control"."resolve_vendor_key"(p_key_hash text)
RETURNS TABLE (vendor_id uuid, key_id uuid, scopes text[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT k.vendor_id, k.id, k.scopes
  FROM control.vendor_keys k
  WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL
$$;
--> statement-breakpoint
-- Records when a key was last used, at most once a minute per key.
CREATE FUNCTION "control"."touch_vendor_key"(p_key_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE control.vendor_keys SET last_used_at = now()
  WHERE id = p_key_id
    AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
$$;
--> statement-breakpoint

-- Audit schema --------------------------------------------------------------------
CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE SEQUENCE "audit"."events_id_seq" AS bigint;
--> statement-breakpoint
-- One row per call through the gateway, allowed or denied. Request and response
-- bodies are never stored. Partitioned by UTC day so old data leaves cheaply.
CREATE TABLE "audit"."events" (
  "id" bigint NOT NULL DEFAULT nextval('audit.events_id_seq'),
  "vendor_id" uuid NOT NULL,
  "ts" timestamptz NOT NULL DEFAULT now(),
  "request_id" uuid NOT NULL,
  "session_id" uuid,
  "end_user_ref" text,
  "primitive" text NOT NULL,
  "action" text NOT NULL,
  "contract_version" integer,
  "decision" text NOT NULL,
  "reason" text NOT NULL,
  "detail" text,
  "scopes" text[] NOT NULL DEFAULT '{}',
  "redacted_fields" text[] NOT NULL DEFAULT '{}',
  "latency_ms" integer,
  CONSTRAINT "events_pkey" PRIMARY KEY ("id", "ts"),
  CONSTRAINT "events_decision_valid" CHECK ("decision" IN ('allowed', 'denied')),
  CONSTRAINT "events_end_user_ref_not_email" CHECK ("end_user_ref" IS NULL OR position('@' in "end_user_ref") = 0)
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
ALTER SEQUENCE "audit"."events_id_seq" OWNED BY "audit"."events"."id";
--> statement-breakpoint
-- Safety net: catches rows for a day whose partition doesn't exist yet.
CREATE TABLE "audit"."events_default" PARTITION OF "audit"."events" DEFAULT;
--> statement-breakpoint
CREATE INDEX "events_vendor_ts_idx" ON "audit"."events" ("vendor_id", "ts" DESC);
--> statement-breakpoint
ALTER TABLE "audit"."events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit"."events" AS PERMISSIVE FOR ALL TO public
  USING (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid);
--> statement-breakpoint
-- A hash per vendor per complete UTC day, chained to the vendor's previous day.
-- Editing or deleting any event inside a checkpointed day changes its hash.
CREATE TABLE "audit"."checkpoints" (
  "vendor_id" uuid NOT NULL,
  "day" date NOT NULL,
  "row_count" integer NOT NULL,
  "last_event_id" bigint,
  "prev_hash" text NOT NULL,
  "hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "checkpoints_pkey" PRIMARY KEY ("vendor_id", "day")
);
--> statement-breakpoint
ALTER TABLE "audit"."checkpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit"."checkpoints" AS PERMISSIVE FOR ALL TO public
  USING (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid);
--> statement-breakpoint

-- Append-only -----------------------------------------------------------------------
-- Nothing may edit audit rows. Deletes happen only inside audit.apply_retention(),
-- which sets audit.retention for its own transaction.
CREATE FUNCTION "audit"."reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('audit.retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit rows are append-only' USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "events_append_only" BEFORE UPDATE OR DELETE ON "audit"."events"
  FOR EACH ROW EXECUTE FUNCTION "audit"."reject_change"();
--> statement-breakpoint
CREATE TRIGGER "checkpoints_append_only" BEFORE UPDATE OR DELETE ON "audit"."checkpoints"
  FOR EACH ROW EXECUTE FUNCTION "audit"."reject_change"();
--> statement-breakpoint

-- Hashing ---------------------------------------------------------------------------
-- A fixed text form of one event. Every field keeps its position, NULL or not.
CREATE FUNCTION "audit"."event_text"(e "audit"."events") RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT array_to_string(ARRAY[
    e.id::text,
    e.vendor_id::text,
    to_char(e.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    e.request_id::text,
    coalesce(e.session_id::text, ''),
    coalesce(e.end_user_ref, ''),
    e.primitive,
    e.action,
    coalesce(e.contract_version::text, ''),
    e.decision,
    e.reason,
    coalesce(e.detail, ''),
    array_to_string(e.scopes, ','),
    array_to_string(e.redacted_fields, ','),
    coalesce(e.latency_ms::text, '')
  ], '|')
$$;
--> statement-breakpoint
CREATE FUNCTION "audit"."compute_day_hash"(p_vendor uuid, p_day date, p_prev text)
RETURNS TABLE (row_count integer, last_event_id bigint, hash text)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*)::integer,
         max(e.id),
         encode(sha256(convert_to(
           p_prev || E'\n' || coalesce(string_agg(audit.event_text(e), E'\n' ORDER BY e.id), ''),
           'UTF8')), 'hex')
  FROM audit.events e
  WHERE e.vendor_id = p_vendor
    AND e.ts >= (p_day::timestamp AT TIME ZONE 'UTC')
    AND e.ts < ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
$$;
--> statement-breakpoint
-- Writes checkpoints for one complete UTC day, for every vendor with events that day
-- and no checkpoint yet. Returns how many it wrote.
CREATE FUNCTION "audit"."write_checkpoints"(p_day date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v uuid;
  prev text;
  r record;
  written integer := 0;
BEGIN
  IF p_day >= (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'checkpoints are only written for complete UTC days';
  END IF;
  FOR v IN
    SELECT DISTINCT e.vendor_id FROM audit.events e
    WHERE e.ts >= (p_day::timestamp AT TIME ZONE 'UTC')
      AND e.ts < ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
      AND NOT EXISTS (
        SELECT 1 FROM audit.checkpoints c WHERE c.vendor_id = e.vendor_id AND c.day = p_day
      )
  LOOP
    prev := NULL;
    SELECT c.hash INTO prev FROM audit.checkpoints c
      WHERE c.vendor_id = v AND c.day < p_day ORDER BY c.day DESC LIMIT 1;
    prev := coalesce(prev, 'genesis');
    SELECT * INTO r FROM audit.compute_day_hash(v, p_day, prev);
    INSERT INTO audit.checkpoints (vendor_id, day, row_count, last_event_id, prev_hash, hash)
      VALUES (v, p_day, r.row_count, r.last_event_id, prev, r.hash);
    written := written + 1;
  END LOOP;
  RETURN written;
END
$$;
--> statement-breakpoint
-- True when the stored checkpoint still matches the events. Only for the vendor the
-- caller acts for (app.vendor_id).
CREATE FUNCTION "audit"."verify_checkpoint"(p_day date) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v uuid := nullif(current_setting('app.vendor_id', true), '')::uuid;
  c record;
  r record;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'app.vendor_id is not set';
  END IF;
  SELECT * INTO c FROM audit.checkpoints WHERE vendor_id = v AND day = p_day;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO r FROM audit.compute_day_hash(v, p_day, c.prev_hash);
  RETURN r.hash = c.hash AND r.row_count = c.row_count;
END
$$;
--> statement-breakpoint

-- Partitions and retention ----------------------------------------------------------
-- Creates daily partitions from yesterday to p_days_ahead days from now (UTC).
-- Skips a day whose rows already landed in the default partition.
CREATE FUNCTION "audit"."ensure_partitions"(p_days_ahead integer DEFAULT 14) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  d date;
  lo timestamptz;
  hi timestamptz;
  part text;
  created integer := 0;
BEGIN
  FOR d IN
    SELECT generate_series((now() AT TIME ZONE 'UTC')::date - 1,
                           (now() AT TIME ZONE 'UTC')::date + p_days_ahead,
                           interval '1 day')::date
  LOOP
    part := 'events_' || to_char(d, 'YYYYMMDD');
    lo := d::timestamp AT TIME ZONE 'UTC';
    hi := (d + 1)::timestamp AT TIME ZONE 'UTC';
    IF to_regclass('audit.' || part) IS NULL
       AND NOT EXISTS (SELECT 1 FROM audit.events_default WHERE ts >= lo AND ts < hi) THEN
      EXECUTE format('CREATE TABLE audit.%I PARTITION OF audit.events FOR VALUES FROM (%L) TO (%L)',
                     part, lo, hi);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;
--> statement-breakpoint
-- Deletes events past each vendor's retention (developer 7 days, startup 30, scale
-- and enterprise 365), then drops daily partitions older than 366 days.
CREATE FUNCTION "audit"."apply_retention"() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  deleted bigint := 0;
  orphaned bigint := 0;
  dropped integer := 0;
  part record;
BEGIN
  PERFORM set_config('audit.retention', 'on', true);
  DELETE FROM audit.events e USING control.vendors v
  WHERE e.vendor_id = v.id
    AND e.ts < now() - make_interval(days => CASE v.tier
                                                WHEN 'developer' THEN 7
                                                WHEN 'startup' THEN 30
                                                ELSE 365 END);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  -- Events of vendors that no longer exist go after the longest retention.
  DELETE FROM audit.events e
  WHERE e.ts < now() - interval '365 days'
    AND NOT EXISTS (SELECT 1 FROM control.vendors v WHERE v.id = e.vendor_id);
  GET DIAGNOSTICS orphaned = ROW_COUNT;
  PERFORM set_config('audit.retention', 'off', true);

  FOR part IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'audit' AND p.relname = 'events'
      AND c.relname ~ '^events_[0-9]{8}$'
      AND to_date(substr(c.relname, 8), 'YYYYMMDD') < (now() AT TIME ZONE 'UTC')::date - 366
  LOOP
    EXECUTE format('DROP TABLE audit.%I', part.relname);
    dropped := dropped + 1;
  END LOOP;

  RETURN jsonb_build_object('deleted', deleted + orphaned, 'partitions_dropped', dropped);
END
$$;
--> statement-breakpoint
-- What the gateway's scheduled run calls: partitions ahead, checkpoints for the last
-- three complete days (so a missed run catches up), then retention.
CREATE FUNCTION "audit"."run_maintenance"() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  today date := (now() AT TIME ZONE 'UTC')::date;
  created integer;
  checkpoints integer := 0;
  d date;
BEGIN
  created := audit.ensure_partitions(14);
  FOR d IN SELECT generate_series(today - 3, today - 1, interval '1 day')::date LOOP
    checkpoints := checkpoints + audit.write_checkpoints(d);
  END LOOP;
  RETURN jsonb_build_object('partitions_created', created, 'checkpoints_written', checkpoints)
         || audit.apply_retention();
END
$$;
--> statement-breakpoint
-- Partitions for the next two weeks, so events have a home from the first call.
SELECT "audit"."ensure_partitions"(14);
--> statement-breakpoint

-- Access ------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION "control"."resolve_vendor_key"(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "control"."touch_vendor_key"(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit"."write_checkpoints"(date) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit"."verify_checkpoint"(date) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit"."ensure_partitions"(integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit"."apply_retention"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit"."run_maintenance"() FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "control", "audit" TO "neuvex_gateway";
--> statement-breakpoint
GRANT SELECT ON "control"."primitives", "control"."contract_versions" TO "neuvex_gateway";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "control"."usage_daily" TO "neuvex_gateway";
--> statement-breakpoint
GRANT INSERT ON "audit"."events" TO "neuvex_gateway";
--> statement-breakpoint
GRANT USAGE ON SEQUENCE "audit"."events_id_seq" TO "neuvex_gateway";
--> statement-breakpoint
GRANT SELECT ON "audit"."checkpoints" TO "neuvex_gateway";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "control"."resolve_vendor_key"(text),
  "control"."touch_vendor_key"(uuid),
  "audit"."verify_checkpoint"(date),
  "audit"."run_maintenance"()
TO "neuvex_gateway";
--> statement-breakpoint
-- GRANT only warns when the grantor lacks the right to grant, so check the result.
DO $$
BEGIN
  IF NOT has_schema_privilege('neuvex_gateway', 'control', 'USAGE') THEN
    RAISE EXCEPTION 'neuvex_gateway has no USAGE on schema control. As neondb_owner, run: GRANT USAGE ON SCHEMA control TO neuvex_migrator WITH GRANT OPTION; then rerun the migration.';
  END IF;
END
$$;
