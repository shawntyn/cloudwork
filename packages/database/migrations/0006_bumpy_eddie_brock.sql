CREATE TABLE "computer_actions" (
	"task_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"epoch" integer NOT NULL,
	"operation" jsonb NOT NULL,
	"state" text NOT NULL,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_actions_task_id_sequence_pk" PRIMARY KEY("task_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "computer_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"run_id" text NOT NULL,
	"request_id" text NOT NULL,
	"goal" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"epoch" integer,
	"runner_id" text,
	"heartbeat_at" timestamp with time zone,
	"deadline" timestamp with time zone NOT NULL,
	"action_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"progress" text,
	"result" text,
	"confirmation" jsonb,
	"instructions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desktop_instances" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"mode" text DEFAULT 'idle' NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"owner" text,
	"control_expires_at" timestamp with time zone,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"image_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "computer_actions" ADD CONSTRAINT "computer_actions_task_id_computer_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."computer_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_tasks" ADD CONSTRAINT "computer_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_tasks" ADD CONSTRAINT "computer_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_tasks" ADD CONSTRAINT "computer_tasks_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_instances" ADD CONSTRAINT "desktop_instances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_instances" ADD CONSTRAINT "desktop_instances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "computer_tasks_request_idx" ON "computer_tasks" USING btree ("run_id","request_id");--> statement-breakpoint
CREATE INDEX "computer_tasks_queue_idx" ON "computer_tasks" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "computer_tasks_workspace_idx" ON "computer_tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "desktop_instances_user_idx" ON "desktop_instances" USING btree ("user_id");