CREATE TYPE "public"."budget_scope" AS ENUM('free', 'paid', 'operator');--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "budget_scope" "budget_scope" DEFAULT 'free' NOT NULL;--> statement-breakpoint
CREATE INDEX "llm_calls_scope_created_idx" ON "llm_calls" USING btree ("budget_scope","created_at");