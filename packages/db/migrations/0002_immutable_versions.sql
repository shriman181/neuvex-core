-- Published contract versions and mold versions are history: an audit entry or a
-- rollback must be able to rely on them never changing. Edits become new versions.
--
-- Rows may still disappear through ON DELETE CASCADE when their primitive, mold or
-- vendor is deleted: a cascaded delete runs inside the foreign key's own trigger,
-- so pg_trigger_depth() is greater than 1 there.
CREATE FUNCTION "control"."reject_version_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are immutable; publish a new version instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "contract_versions_immutable"
  BEFORE UPDATE OR DELETE ON "control"."contract_versions"
  FOR EACH ROW EXECUTE FUNCTION "control"."reject_version_change"();
--> statement-breakpoint
CREATE TRIGGER "mold_versions_immutable"
  BEFORE UPDATE OR DELETE ON "control"."mold_versions"
  FOR EACH ROW EXECUTE FUNCTION "control"."reject_version_change"();
