CREATE TABLE "mcp_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"server_name" text NOT NULL,
	"url" text NOT NULL,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"secret_ciphertext" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_test_status" text DEFAULT 'never' NOT NULL,
	"last_test_error" text,
	"last_test_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_run_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"run_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"revision" integer NOT NULL,
	"server_name" text NOT NULL,
	"url" text NOT NULL,
	"secret_ciphertext" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_run_grants_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "workspace_mcp_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_mcp_bindings" ADD CONSTRAINT "workspace_mcp_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_mcp_bindings" ADD CONSTRAINT "workspace_mcp_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_mcp_bindings" ADD CONSTRAINT "workspace_mcp_bindings_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_connections_user_idx" ON "mcp_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_server_idx" ON "mcp_connections" USING btree ("user_id","server_name");--> statement-breakpoint
CREATE INDEX "mcp_run_grants_run_idx" ON "mcp_run_grants" USING btree ("user_id","run_id");--> statement-breakpoint
CREATE INDEX "mcp_run_grants_expiry_idx" ON "mcp_run_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_mcp_binding_unique" ON "workspace_mcp_bindings" USING btree ("workspace_id","connection_id");--> statement-breakpoint
CREATE INDEX "workspace_mcp_bindings_user_idx" ON "workspace_mcp_bindings" USING btree ("user_id");