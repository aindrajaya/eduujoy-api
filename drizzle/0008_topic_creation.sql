ALTER TABLE "topics" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "topics_created_by_idx" ON "topics" USING btree ("created_by","created_at");