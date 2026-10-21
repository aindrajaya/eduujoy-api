ALTER TYPE "public"."llm_call_status" ADD VALUE 'refused';--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "failure" text;