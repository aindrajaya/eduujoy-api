ALTER TABLE "billing_events" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "provider_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "entitlements_provider_subscription_idx" ON "entitlements" USING btree ("provider_subscription_id");