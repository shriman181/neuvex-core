ALTER TABLE "control"."vendors" ADD COLUMN "neon_production_branch_id" text;--> statement-breakpoint
ALTER TABLE "control"."vendors" ADD COLUMN "neon_fixtures_branch_id" text;--> statement-breakpoint
ALTER TABLE "control"."vendors" ADD COLUMN "gateway_db_url_enc" text;--> statement-breakpoint
ALTER TABLE "control"."vendors" ADD COLUMN "template_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "control"."vendors" ADD COLUMN "provision_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "control"."vendors" ADD COLUMN "provision_error" text;--> statement-breakpoint
ALTER TABLE "control"."vendors" ADD COLUMN "provisioned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "control"."vendors" ADD CONSTRAINT "vendors_provision_status_valid" CHECK ("control"."vendors"."provision_status" in ('pending', 'provisioning', 'ready', 'failed'));