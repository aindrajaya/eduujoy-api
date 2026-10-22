ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "credit_ledger" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
-- Existing sessions predate auth_time: backfill the epoch, so they must sign in again before DELETE /v1/me.
ALTER TABLE "sessions" ADD COLUMN "auth_time" timestamp with time zone NOT NULL DEFAULT 'epoch';--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "auth_time" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "subject_ref" text;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;