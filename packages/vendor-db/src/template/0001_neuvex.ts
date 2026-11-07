// Every vendor project: which vendor it belongs to, its settings, and the roles
// Neuvex uses. Runs as the project's owner role (neondb_owner).

export const name = "neuvex";

export const sql = /* sql */ `
-- Exactly one row: the vendor this project belongs to and its settings.
CREATE TABLE neuvex.settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  vendor_id uuid NOT NULL,
  vendor_slug text NOT NULL,
  audit_retention_days integer NOT NULL CHECK (audit_retention_days BETWEEN 1 AND 3660),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Sets this project's vendor and settings. The vendor can be set once; calling it
-- with a different vendor fails, so a mixed-up connection string can't relabel a
-- project.
CREATE FUNCTION neuvex.configure(p_vendor_id uuid, p_slug text, p_retention_days integer)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  current_vendor uuid;
BEGIN
  SELECT vendor_id INTO current_vendor FROM neuvex.settings;
  IF current_vendor IS NOT NULL AND current_vendor <> p_vendor_id THEN
    RAISE EXCEPTION 'this Neon project belongs to vendor %, not %', current_vendor, p_vendor_id;
  END IF;
  INSERT INTO neuvex.settings (vendor_id, vendor_slug, audit_retention_days)
  VALUES (p_vendor_id, p_slug, p_retention_days)
  ON CONFLICT (id) DO UPDATE
    SET vendor_slug = excluded.vendor_slug,
        audit_retention_days = excluded.audit_retention_days,
        updated_at = now();
END
$$;
--> statement-breakpoint
-- Lets a connection confirm which vendor's project it reached.
CREATE FUNCTION neuvex.vendor_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT vendor_id FROM neuvex.settings
$$;
--> statement-breakpoint
-- The gateway's role. Created without a password, so it can't log in until the
-- provisioner sets one with neuvex.set_login_password().
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neuvex_gateway') THEN
    CREATE ROLE neuvex_gateway NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
-- Passwords can't be query parameters in CREATE/ALTER ROLE, so this quotes them
-- safely. Only for Neuvex's own roles.
CREATE FUNCTION neuvex.set_login_password(p_role text, p_password text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_role NOT IN ('neuvex_gateway') THEN
    RAISE EXCEPTION 'not a Neuvex role: %', p_role;
  END IF;
  IF length(p_password) < 24 THEN
    RAISE EXCEPTION 'password too short';
  END IF;
  EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', p_role, p_password);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION neuvex.configure(uuid, text, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION neuvex.vendor_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION neuvex.set_login_password(text, text) FROM PUBLIC;
--> statement-breakpoint
-- Nobody but the owner creates objects in public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
`;
