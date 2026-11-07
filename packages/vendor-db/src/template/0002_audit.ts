// The vendor's audit log: one row per gateway decision, partitioned by UTC day,
// append-only, with a daily hash chained to the previous day's. Same row format as
// the control-plane log (migration 0003), but one vendor per project, so no
// row-level security, and retention drops whole daily partitions.

export const name = "audit";

export const sql = /* sql */ `
CREATE SCHEMA audit;
--> statement-breakpoint
CREATE SEQUENCE audit.events_id_seq AS bigint;
--> statement-breakpoint
CREATE TABLE audit.events (
  id bigint NOT NULL DEFAULT nextval('audit.events_id_seq'),
  vendor_id uuid NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  request_id uuid NOT NULL,
  session_id uuid,
  end_user_ref text,
  primitive text NOT NULL,
  action text NOT NULL,
  contract_version integer,
  decision text NOT NULL,
  reason text NOT NULL,
  detail text,
  scopes text[] NOT NULL DEFAULT '{}',
  redacted_fields text[] NOT NULL DEFAULT '{}',
  latency_ms integer,
  CONSTRAINT events_pkey PRIMARY KEY (id, ts),
  CONSTRAINT events_decision_valid CHECK (decision IN ('allowed', 'denied')),
  CONSTRAINT events_end_user_ref_not_email CHECK (end_user_ref IS NULL OR position('@' in end_user_ref) = 0)
) PARTITION BY RANGE (ts);
--> statement-breakpoint
ALTER SEQUENCE audit.events_id_seq OWNED BY audit.events.id;
--> statement-breakpoint
CREATE TABLE audit.events_default PARTITION OF audit.events DEFAULT;
--> statement-breakpoint
CREATE INDEX events_ts_idx ON audit.events (ts DESC);
--> statement-breakpoint
-- Only this project's vendor may appear in its log.
CREATE FUNCTION audit.check_vendor() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.vendor_id IS DISTINCT FROM neuvex.vendor_id() THEN
    RAISE EXCEPTION 'event for vendor % does not belong in this project', NEW.vendor_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER events_vendor_matches BEFORE INSERT ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.check_vendor();
--> statement-breakpoint
CREATE TABLE audit.checkpoints (
  day date PRIMARY KEY,
  row_count integer NOT NULL,
  last_event_id bigint,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Nothing edits audit rows. Rows in the default partition are deleted only inside
-- audit.apply_retention(); daily partitions are dropped whole.
CREATE FUNCTION audit.reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('audit.retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit rows are append-only' USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
--> statement-breakpoint
CREATE TRIGGER checkpoints_append_only BEFORE UPDATE OR DELETE ON audit.checkpoints
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
--> statement-breakpoint
CREATE FUNCTION audit.event_text(e audit.events) RETURNS text
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
CREATE FUNCTION audit.compute_day_hash(p_day date, p_prev text)
RETURNS TABLE (row_count integer, last_event_id bigint, hash text)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*)::integer,
         max(e.id),
         encode(sha256(convert_to(
           p_prev || E'\\n' || coalesce(string_agg(audit.event_text(e), E'\\n' ORDER BY e.id), ''),
           'UTF8')), 'hex')
  FROM audit.events e
  WHERE e.ts >= (p_day::timestamp AT TIME ZONE 'UTC')
    AND e.ts < ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
$$;
--> statement-breakpoint
-- Checkpoints one complete UTC day that has events and no checkpoint yet.
CREATE FUNCTION audit.write_checkpoint(p_day date) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prev text;
  r record;
BEGIN
  IF p_day >= (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'checkpoints are only written for complete UTC days';
  END IF;
  IF EXISTS (SELECT 1 FROM audit.checkpoints WHERE day = p_day) THEN
    RETURN false;
  END IF;
  SELECT * INTO r FROM audit.compute_day_hash(p_day, '');
  IF r.row_count = 0 THEN
    RETURN false;
  END IF;
  SELECT c.hash INTO prev FROM audit.checkpoints c WHERE c.day < p_day ORDER BY c.day DESC LIMIT 1;
  prev := coalesce(prev, 'genesis');
  SELECT * INTO r FROM audit.compute_day_hash(p_day, prev);
  INSERT INTO audit.checkpoints (day, row_count, last_event_id, prev_hash, hash)
    VALUES (p_day, r.row_count, r.last_event_id, prev, r.hash);
  RETURN true;
END
$$;
--> statement-breakpoint
-- True when the stored checkpoint still matches the day's events; NULL if none.
CREATE FUNCTION audit.verify_checkpoint(p_day date) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c record;
  r record;
BEGIN
  SELECT * INTO c FROM audit.checkpoints WHERE day = p_day;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO r FROM audit.compute_day_hash(p_day, c.prev_hash);
  RETURN r.hash = c.hash AND r.row_count = c.row_count;
END
$$;
--> statement-breakpoint
CREATE FUNCTION audit.ensure_partitions(p_days_ahead integer DEFAULT 14) RETURNS integer
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
-- Drops daily partitions that are wholly past retention (neuvex.settings), and
-- deletes old rows that landed in the default partition.
CREATE FUNCTION audit.apply_retention() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  days integer := (SELECT audit_retention_days FROM neuvex.settings);
  cutoff timestamptz;
  deleted bigint := 0;
  dropped integer := 0;
  part record;
BEGIN
  IF days IS NULL THEN
    RAISE EXCEPTION 'neuvex.settings is not configured';
  END IF;
  cutoff := now() - make_interval(days => days);

  PERFORM set_config('audit.retention', 'on', true);
  DELETE FROM audit.events_default WHERE ts < cutoff;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM set_config('audit.retention', 'off', true);

  FOR part IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'audit' AND p.relname = 'events'
      AND c.relname ~ '^events_[0-9]{8}$'
      AND (to_date(substr(c.relname, 8), 'YYYYMMDD') + 1)::timestamp AT TIME ZONE 'UTC' <= cutoff
  LOOP
    EXECUTE format('DROP TABLE audit.%I', part.relname);
    dropped := dropped + 1;
  END LOOP;

  RETURN jsonb_build_object('deleted', deleted, 'partitions_dropped', dropped);
END
$$;
--> statement-breakpoint
CREATE FUNCTION audit.run_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  today date := (now() AT TIME ZONE 'UTC')::date;
  created integer;
  written integer := 0;
  d date;
BEGIN
  created := audit.ensure_partitions(14);
  FOR d IN SELECT generate_series(today - 3, today - 1, interval '1 day')::date LOOP
    IF audit.write_checkpoint(d) THEN
      written := written + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('partitions_created', created, 'checkpoints_written', written)
         || audit.apply_retention();
END
$$;
--> statement-breakpoint
SELECT audit.ensure_partitions(14);
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit.write_checkpoint(date) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit.verify_checkpoint(date) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit.ensure_partitions(integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit.apply_retention() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit.run_maintenance() FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA neuvex, audit TO neuvex_gateway;
--> statement-breakpoint
GRANT INSERT ON audit.events TO neuvex_gateway;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE audit.events_id_seq TO neuvex_gateway;
--> statement-breakpoint
GRANT SELECT ON audit.checkpoints TO neuvex_gateway;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION neuvex.vendor_id(), audit.verify_checkpoint(date), audit.run_maintenance()
  TO neuvex_gateway;
`;
