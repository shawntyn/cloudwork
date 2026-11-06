CREATE TYPE "public"."message_request_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "agent_message_requests" (
	"session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"prompt" text NOT NULL,
	"prompt_fingerprint" text NOT NULL,
	"status" "message_request_status" DEFAULT 'queued' NOT NULL,
	"run_id" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"mcp_revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_message_requests_session_id_request_id_pk" PRIMARY KEY("session_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "agent_message_requests" ADD CONSTRAINT "agent_message_requests_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_message_requests_status_created_idx" ON "agent_message_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "agent_message_requests_cleanup_idx" ON "agent_message_requests" USING btree ("status","mcp_revoked_at");
