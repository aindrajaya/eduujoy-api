CREATE TYPE "public"."bloom_level" AS ENUM('C1', 'C2', 'C3', 'C4', 'C5', 'C6');--> statement-breakpoint
CREATE TYPE "public"."dreyfus_stage" AS ENUM('novice', 'advanced_beginner', 'competent', 'proficient', 'expert');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'subscription');--> statement-breakpoint
CREATE TYPE "public"."position_source" AS ENUM('diagnostic', 'checkpoint', 'override');--> statement-breakpoint
CREATE TYPE "public"."resource_format" AS ENUM('video', 'text', 'papers');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('learner', 'reviewer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."topic_domain" AS ENUM('software', 'stem', 'non_technical');--> statement-breakpoint
CREATE TYPE "public"."topic_origin" AS ENUM('seed', 'learner', 'reviewer');--> statement-breakpoint
CREATE TYPE "public"."diagnostic_item_kind" AS ENUM('single_choice', 'multi_choice', 'short_answer', 'scenario');--> statement-breakpoint
CREATE TYPE "public"."diagnostic_status" AS ENUM('in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('queued', 'grading', 'graded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."resource_type" AS ENUM('youtube', 'article', 'official_doc', 'paper', 'related');--> statement-breakpoint
CREATE TYPE "public"."path_status" AS ENUM('generating', 'active', 'completed', 'failed', 'under_review');--> statement-breakpoint
CREATE TYPE "public"."step_difficulty" AS ENUM('too_easy', 'ok', 'too_hard');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('locked', 'active', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."feedback_kind" AS ENUM('up', 'down', 'swap', 'too_easy', 'too_hard', 'flag');--> statement-breakpoint
CREATE TYPE "public"."feedback_target_type" AS ENUM('resource', 'step');--> statement-breakpoint
CREATE TYPE "public"."credit_reason" AS ENUM('purchase', 'path', 'refund');--> statement-breakpoint
CREATE TYPE "public"."review_kind" AS ENUM('diagnostic_item', 'resource', 'path', 'learner_report');--> statement-breakpoint
CREATE TYPE "public"."review_resolution" AS ENUM('approved', 'rejected', 'edited');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."llm_call_status" AS ENUM('ok', 'error', 'timeout', 'invalid_output');--> statement-breakpoint
CREATE TYPE "public"."llm_provider" AS ENUM('anthropic', 'google');--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"ip_hash" text,
	"succeeded" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"refresh_hash" text NOT NULL,
	"replaced_by" uuid,
	"user_agent" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"weekly_hours_default" real,
	"password_hash" text,
	"google_sub" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topic_prerequisites" (
	"topic_id" uuid NOT NULL,
	"prerequisite_id" uuid NOT NULL,
	CONSTRAINT "topic_prerequisites_topic_id_prerequisite_id_pk" PRIMARY KEY("topic_id","prerequisite_id"),
	CONSTRAINT "topic_prerequisites_no_self_edge" CHECK ("topic_prerequisites"."topic_id" <> "topic_prerequisites"."prerequisite_id")
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"canonical_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"domain" "topic_domain",
	"parent_id" uuid,
	"origin" "topic_origin" DEFAULT 'seed' NOT NULL,
	"embedding" vector(768),
	"embedding_model" text,
	"embedding_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkpoint_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"submission_id" uuid,
	"answer" jsonb NOT NULL,
	"score" integer NOT NULL,
	"passed" boolean NOT NULL,
	"feedback" jsonb,
	"misconception" text,
	"graded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoint_attempts_score_range" CHECK ("checkpoint_attempts"."score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "checkpoint_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"answers" jsonb NOT NULL,
	"status" "submission_status" DEFAULT 'queued' NOT NULL,
	"score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"graded_at" timestamp with time zone,
	CONSTRAINT "checkpoint_submissions_score_range" CHECK ("checkpoint_submissions"."score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "diagnostic_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"answer" jsonb NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	"score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnostic_answers_score_range" CHECK ("diagnostic_answers"."score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "diagnostic_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"stage" "dreyfus_stage" NOT NULL,
	"bloom" "bloom_level" NOT NULL,
	"kind" "diagnostic_item_kind" NOT NULL,
	"body" jsonb NOT NULL,
	"rubric" jsonb,
	"reviewed" boolean DEFAULT false NOT NULL,
	"seed_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnostic_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"weekly_hours" real NOT NULL,
	"preferred_formats" "resource_format"[] DEFAULT '{}' NOT NULL,
	"self_report" jsonb,
	"status" "diagnostic_status" DEFAULT 'in_progress' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"stage" "dreyfus_stage" NOT NULL,
	"bloom" "bloom_level" NOT NULL,
	"confidence" real NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "placements_confidence_range" CHECK ("placements"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "discovery_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic_id" uuid NOT NULL,
	"stage" "dreyfus_stage" NOT NULL,
	"pool_version" integer NOT NULL,
	"resource_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"dreyfus_stage" "dreyfus_stage" NOT NULL,
	"bloom_levels" "bloom_level"[] NOT NULL,
	"prerequisites" text[] DEFAULT '{}'::text[] NOT NULL,
	"concepts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"key_takeaways" text[] DEFAULT '{}'::text[] NOT NULL,
	"why_this" text,
	"quality" jsonb NOT NULL,
	"quality_score" real NOT NULL,
	"embedding" vector(768),
	"embedding_model" text,
	"embedding_version" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"type" "resource_type" NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"youtube_id" text,
	"duration_min" integer,
	"reading_min" integer,
	"published_at" date,
	"language" text DEFAULT 'en' NOT NULL,
	"http_status" integer,
	"last_checked_at" timestamp with time zone,
	"dead_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "path_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"objective" text NOT NULL,
	"bloom" "bloom_level" NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resource_ids" uuid[] NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"done_when" text NOT NULL,
	"est_minutes" integer NOT NULL,
	"status" "step_status" DEFAULT 'locked' NOT NULL,
	"remedial" boolean DEFAULT false NOT NULL,
	"difficulty" "step_difficulty",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "path_steps_n_positive" CHECK ("path_steps"."n" >= 1),
	CONSTRAINT "path_steps_est_minutes_positive" CHECK ("path_steps"."est_minutes" >= 1)
);
--> statement-breakpoint
CREATE TABLE "paths" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"placement_id" uuid,
	"from_stage" "dreyfus_stage" NOT NULL,
	"from_bloom" "bloom_level" NOT NULL,
	"to_stage" "dreyfus_stage" NOT NULL,
	"to_bloom" "bloom_level" NOT NULL,
	"status" "path_status" DEFAULT 'generating' NOT NULL,
	"goal" text,
	"weekly_hours" real,
	"model" text,
	"prompt_version" text,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_type" "feedback_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"kind" "feedback_kind" NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learner_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"stage" "dreyfus_stage" NOT NULL,
	"bloom" "bloom_level" NOT NULL,
	"confidence" real NOT NULL,
	"source" "position_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learner_positions_confidence_range" CHECK ("learner_positions"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" "credit_reason" NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"monthly_path_quota" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"provider_subscription_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "review_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb,
	"status" "review_status" DEFAULT 'open' NOT NULL,
	"resolution" "review_resolution",
	"note" text,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"user_id" uuid,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage" text NOT NULL,
	"provider" "llm_provider" NOT NULL,
	"model" text NOT NULL,
	"prompt_name" text,
	"prompt_version" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer NOT NULL,
	"status" "llm_call_status" NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_prerequisites" ADD CONSTRAINT "topic_prerequisites_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_prerequisites" ADD CONSTRAINT "topic_prerequisites_prerequisite_id_topics_id_fk" FOREIGN KEY ("prerequisite_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_parent_id_topics_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_attempts" ADD CONSTRAINT "checkpoint_attempts_step_id_path_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."path_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_attempts" ADD CONSTRAINT "checkpoint_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_attempts" ADD CONSTRAINT "checkpoint_attempts_submission_id_checkpoint_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."checkpoint_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_submissions" ADD CONSTRAINT "checkpoint_submissions_step_id_path_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."path_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_submissions" ADD CONSTRAINT "checkpoint_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_answers" ADD CONSTRAINT "diagnostic_answers_session_id_diagnostic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."diagnostic_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_answers" ADD CONSTRAINT "diagnostic_answers_item_id_diagnostic_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."diagnostic_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_items" ADD CONSTRAINT "diagnostic_items_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_sessions" ADD CONSTRAINT "diagnostic_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_sessions" ADD CONSTRAINT "diagnostic_sessions_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_session_id_diagnostic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."diagnostic_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_results" ADD CONSTRAINT "discovery_results_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_cards" ADD CONSTRAINT "resource_cards_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_cards" ADD CONSTRAINT "resource_cards_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_steps" ADD CONSTRAINT "path_steps_path_id_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."paths"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paths" ADD CONSTRAINT "paths_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paths" ADD CONSTRAINT "paths_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paths" ADD CONSTRAINT "paths_placement_id_placements_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."placements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_positions" ADD CONSTRAINT "learner_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_positions" ADD CONSTRAINT "learner_positions_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_attempts_email_created_idx" ON "login_attempts" USING btree (lower("email"),"created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_hash_key" ON "sessions" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_family_id_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_sub_key" ON "users" USING btree ("google_sub");--> statement-breakpoint
CREATE INDEX "topic_prerequisites_prerequisite_idx" ON "topic_prerequisites" USING btree ("prerequisite_id");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_slug_key" ON "topics" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "topics_parent_id_idx" ON "topics" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "topics_embedding_hnsw_idx" ON "topics" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "checkpoint_attempts_step_user_idx" ON "checkpoint_attempts" USING btree ("step_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoint_submissions_idempotency_key" ON "checkpoint_submissions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "checkpoint_submissions_step_user_idx" ON "checkpoint_submissions" USING btree ("step_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "diagnostic_answers_session_item_key" ON "diagnostic_answers" USING btree ("session_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "diagnostic_items_seed_key_key" ON "diagnostic_items" USING btree ("seed_key");--> statement-breakpoint
CREATE INDEX "diagnostic_items_topic_stage_bloom_idx" ON "diagnostic_items" USING btree ("topic_id","stage","bloom");--> statement-breakpoint
CREATE INDEX "diagnostic_sessions_user_idx" ON "diagnostic_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "placements_session_key" ON "placements" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_results_topic_stage_version_key" ON "discovery_results" USING btree ("topic_id","stage","pool_version");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_cards_resource_topic_prompt_key" ON "resource_cards" USING btree ("resource_id","topic_id","prompt_version");--> statement-breakpoint
CREATE INDEX "resource_cards_topic_stage_idx" ON "resource_cards" USING btree ("topic_id","dreyfus_stage");--> statement-breakpoint
CREATE INDEX "resource_cards_bloom_levels_gin_idx" ON "resource_cards" USING gin ("bloom_levels");--> statement-breakpoint
CREATE INDEX "resource_cards_embedding_hnsw_idx" ON "resource_cards" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "resources_url_key" ON "resources" USING btree ("url");--> statement-breakpoint
CREATE INDEX "resources_last_checked_idx" ON "resources" USING btree ("last_checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "path_steps_path_n_key" ON "path_steps" USING btree ("path_id","n");--> statement-breakpoint
CREATE INDEX "paths_user_created_idx" ON "paths" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "paths_topic_idx" ON "paths" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "feedback_events_target_idx" ON "feedback_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "feedback_events_user_idx" ON "feedback_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "learner_positions_user_topic_created_idx" ON "learner_positions" USING btree ("user_id","topic_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_provider_event_id_key" ON "billing_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_user_idx" ON "credit_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_reason_external_ref_key" ON "credit_ledger" USING btree ("reason","external_ref") WHERE "credit_ledger"."external_ref" is not null;--> statement-breakpoint
CREATE INDEX "review_items_status_created_idx" ON "review_items" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "review_items_target_idx" ON "review_items" USING btree ("kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_status_run_after_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "jobs_user_idx" ON "jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_stage_model_idx" ON "llm_calls" USING btree ("stage","model","created_at");