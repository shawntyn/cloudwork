ALTER TABLE "agent_sessions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "first_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
-- Before this migration, only a run changed an agent session's updated_at.
-- Mark such sessions as used so old conversations are never mistaken for empty drafts.
UPDATE "agent_sessions" SET "first_message_at" = "updated_at" WHERE "updated_at" <> "created_at" OR "status" <> 'idle';--> statement-breakpoint
UPDATE "agent_sessions" SET "last_activity_at" = GREATEST("created_at", "updated_at");--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "last_activity_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "last_activity_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ui_theme" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ui_locale" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_sessions_navigation_idx" ON "agent_sessions" USING btree ("user_id","archived_at","last_activity_at");
