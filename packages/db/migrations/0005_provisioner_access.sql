-- Phase 3: exactly the access the provisioner needs in the control plane.
--
-- The provisioner creates each vendor's Neon project and records what it made. It
-- reads vendors and updates only the provisioning columns, one vendor at a time under
-- row-level security. It cannot create, rename or delete vendors, or change tiers.
--
-- Requires the neuvex_provisioner role, created by hand on production as
-- neondb_owner before this runs (see README, "One-time database setup").

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neuvex_provisioner') THEN
    RAISE EXCEPTION 'The neuvex_provisioner role does not exist. Create it on production as neondb_owner (README, "One-time database setup"), then rerun the migration.';
  END IF;
END
$$;
--> statement-breakpoint
-- The provisioner is started with a vendor's slug and has to find its ID before it
-- can act for that vendor, so this one lookup runs with the owner's rights.
CREATE FUNCTION "control"."vendor_id_for_slug"(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT v.id FROM control.vendors v WHERE v.slug = p_slug
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "control"."vendor_id_for_slug"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "control" TO "neuvex_provisioner";
--> statement-breakpoint
GRANT SELECT ON "control"."vendors" TO "neuvex_provisioner";
--> statement-breakpoint
GRANT UPDATE (
  "neon_project_id",
  "region",
  "neon_production_branch_id",
  "neon_fixtures_branch_id",
  "gateway_db_url_enc",
  "template_version",
  "provision_status",
  "provision_error",
  "provisioned_at",
  "updated_at"
) ON "control"."vendors" TO "neuvex_provisioner";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "control"."vendor_id_for_slug"(text) TO "neuvex_provisioner";
--> statement-breakpoint
-- GRANT only warns when the grantor lacks the right to grant, so check the result.
DO $$
BEGIN
  IF NOT has_schema_privilege('neuvex_provisioner', 'control', 'USAGE') THEN
    RAISE EXCEPTION 'neuvex_provisioner has no USAGE on schema control. As neondb_owner, run: GRANT USAGE ON SCHEMA control TO neuvex_migrator WITH GRANT OPTION; then rerun the migration.';
  END IF;
END
$$;
