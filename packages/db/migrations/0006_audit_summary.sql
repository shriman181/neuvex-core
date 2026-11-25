-- A read-only summary of the calling vendor's audit log, for GET /v1/audit/summary.
--
-- The gateway still cannot SELECT audit.events. This function, run with the owner's
-- rights, returns one vendor's numbers only (the one set in app.vendor_id), and only
-- fields with a fixed shape: no end_user_ref, no detail, nothing a caller typed. That
-- keeps it safe to show on a public page such as the Neuvex Playground.

CREATE FUNCTION "audit"."vendor_summary"(p_recent integer DEFAULT 12) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v uuid := nullif(current_setting('app.vendor_id', true), '')::uuid;
  today date := (now() AT TIME ZONE 'UTC')::date;
  day_start timestamptz := (now() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC';
  n integer := least(greatest(coalesce(p_recent, 12), 0), 50);
  part text := 'events_' || to_char((now() AT TIME ZONE 'UTC')::date, 'YYYYMMDD');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'app.vendor_id is not set';
  END IF;

  RETURN jsonb_build_object(
    'today', (
      SELECT jsonb_build_object(
        'date', today,
        'allowed', count(*) FILTER (WHERE e.decision = 'allowed'),
        'denied', count(*) FILTER (WHERE e.decision = 'denied'))
      FROM audit.events e
      WHERE e.vendor_id = v AND e.ts >= day_start),
    'total', (SELECT count(*) FROM audit.events e WHERE e.vendor_id = v),
    'recent', coalesce((
      SELECT jsonb_agg(to_jsonb(r) ORDER BY r.ts DESC, r.id DESC)
      FROM (
        SELECT e.id, e.ts, e.primitive, e.action, e.decision, e.reason, e.contract_version, e.latency_ms
        FROM audit.events e
        WHERE e.vendor_id = v
        ORDER BY e.ts DESC, e.id DESC
        LIMIT n) r), '[]'::jsonb),
    'checkpoints', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'day', c.day,
               'events', c.row_count,
               'hash', left(c.hash, 16),
               'verified', audit.verify_checkpoint(c.day))
             ORDER BY c.day DESC)
      FROM (
        SELECT cp.day, cp.row_count, cp.hash
        FROM audit.checkpoints cp
        WHERE cp.vendor_id = v
        ORDER BY cp.day DESC
        LIMIT 7) c), '[]'::jsonb),
    'storage', jsonb_build_object(
      'table', 'audit.events',
      'partition', CASE WHEN to_regclass('audit.' || part) IS NOT NULL
                        THEN 'audit.' || part ELSE 'audit.events_default' END,
      'postgres', current_setting('server_version'))
  );
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit"."vendor_summary"(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "audit"."vendor_summary"(integer) TO "neuvex_gateway";
