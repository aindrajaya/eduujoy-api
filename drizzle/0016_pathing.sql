CREATE TABLE "path_request_replays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"path_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "path_steps" ADD COLUMN "answer_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "paths" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "path_request_replays" ADD CONSTRAINT "path_request_replays_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_request_replays" ADD CONSTRAINT "path_request_replays_path_id_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."paths"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "path_request_replays_user_key" ON "path_request_replays" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "paths_user_placement_live_key" ON "paths" USING btree ("user_id","placement_id") WHERE "paths"."placement_id" is not null and "paths"."status" <> 'failed';