CREATE TABLE "control"."agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"mold_id" uuid,
	"neon_branch_id" text,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_sessions_status_valid" CHECK ("control"."agent_sessions"."status" in ('provisioning', 'active', 'publishing', 'published', 'discarded', 'expired', 'failed')),
	CONSTRAINT "agent_sessions_expiry_after_start" CHECK ("control"."agent_sessions"."expires_at" > "control"."agent_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "control"."agent_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "control"."contract_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"primitive_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_versions_primitive_version_key" UNIQUE("vendor_id","primitive_id","version"),
	CONSTRAINT "contract_versions_version_positive" CHECK ("control"."contract_versions"."version" > 0),
	CONSTRAINT "contract_versions_rules_shape" CHECK (coalesce(jsonb_typeof("control"."contract_versions"."rules" -> 'allow'), 'missing') = 'object')
);
--> statement-breakpoint
ALTER TABLE "control"."contract_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "control"."mold_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"mold_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"bundle_ref" text NOT NULL,
	"migration_up" text,
	"migration_down" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mold_versions_mold_version_key" UNIQUE("vendor_id","mold_id","version"),
	CONSTRAINT "mold_versions_version_positive" CHECK ("control"."mold_versions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "control"."mold_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "control"."molds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"end_user_ref" text NOT NULL,
	"name" text NOT NULL,
	"current_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "molds_vendor_id_id_key" UNIQUE("vendor_id","id"),
	CONSTRAINT "molds_end_user_ref_not_email" CHECK (position('@' in "control"."molds"."end_user_ref") = 0)
);
--> statement-breakpoint
ALTER TABLE "control"."molds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "control"."primitives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "primitives_vendor_name_key" UNIQUE("vendor_id","name"),
	CONSTRAINT "primitives_vendor_id_id_key" UNIQUE("vendor_id","id"),
	CONSTRAINT "primitives_name_format" CHECK ("control"."primitives"."name" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);
--> statement-breakpoint
ALTER TABLE "control"."primitives" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "control"."usage_daily" (
	"vendor_id" uuid NOT NULL,
	"day" date NOT NULL,
	"molded_sessions" integer DEFAULT 0 NOT NULL,
	"primitive_calls" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_pkey" PRIMARY KEY("vendor_id","day"),
	CONSTRAINT "usage_daily_counts_non_negative" CHECK ("control"."usage_daily"."molded_sessions" >= 0 and "control"."usage_daily"."primitive_calls" >= 0)
);
--> statement-breakpoint
ALTER TABLE "control"."usage_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "control"."vendor_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "vendor_keys_key_hash_key" UNIQUE("key_hash"),
	CONSTRAINT "vendor_keys_hash_format" CHECK ("control"."vendor_keys"."key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "control"."vendor_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "control"."vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tier" text DEFAULT 'developer' NOT NULL,
	"neon_project_id" text,
	"region" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_slug_key" UNIQUE("slug"),
	CONSTRAINT "vendors_slug_format" CHECK ("control"."vendors"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "vendors_tier_valid" CHECK ("control"."vendors"."tier" in ('developer', 'startup', 'scale', 'enterprise'))
);
--> statement-breakpoint
ALTER TABLE "control"."vendors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "control"."agent_sessions" ADD CONSTRAINT "agent_sessions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "control"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."agent_sessions" ADD CONSTRAINT "agent_sessions_mold_fk" FOREIGN KEY ("vendor_id","mold_id") REFERENCES "control"."molds"("vendor_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."contract_versions" ADD CONSTRAINT "contract_versions_primitive_fk" FOREIGN KEY ("vendor_id","primitive_id") REFERENCES "control"."primitives"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."mold_versions" ADD CONSTRAINT "mold_versions_mold_fk" FOREIGN KEY ("vendor_id","mold_id") REFERENCES "control"."molds"("vendor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."molds" ADD CONSTRAINT "molds_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "control"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."primitives" ADD CONSTRAINT "primitives_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "control"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."usage_daily" ADD CONSTRAINT "usage_daily_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "control"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."vendor_keys" ADD CONSTRAINT "vendor_keys_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "control"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_vendor_status_idx" ON "control"."agent_sessions" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE INDEX "agent_sessions_expires_idx" ON "control"."agent_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "molds_vendor_user_idx" ON "control"."molds" USING btree ("vendor_id","end_user_ref");--> statement-breakpoint
CREATE INDEX "vendor_keys_vendor_idx" ON "control"."vendor_keys" USING btree ("vendor_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "control"."agent_sessions" AS PERMISSIVE FOR ALL TO public USING (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid) WITH CHECK (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "control"."contract_versions" AS PERMISSIVE FOR ALL TO public USING (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid) WITH CHECK (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "control"."mold_versions" AS PERMISSIVE FOR ALL TO public USING (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid) WITH CHECK (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "control"."molds" AS PERMISSIVE FOR ALL TO public USING (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid) WITH CHECK (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "control"."primitives" AS PERMISSIVE FOR ALL TO public USING (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid) WITH CHECK (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "control"."usage_daily" AS PERMISSIVE FOR ALL TO public USING (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid) WITH CHECK (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "control"."vendor_keys" AS PERMISSIVE FOR ALL TO public USING (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid) WITH CHECK (vendor_id = nullif(current_setting('app.vendor_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "control"."vendors" AS PERMISSIVE FOR ALL TO public USING (id = nullif(current_setting('app.vendor_id', true), '')::uuid) WITH CHECK (id = nullif(current_setting('app.vendor_id', true), '')::uuid);