CREATE TYPE "public"."discovery_pool_status" AS ENUM('analysing', 'ready', 'thin');--> statement-breakpoint
CREATE TYPE "public"."resource_card_status" AS ENUM('served', 'review', 'dropped', 'duplicate');--> statement-breakpoint
CREATE TABLE "provider_quota_usage" (
	"quota" text NOT NULL,
	"day" date NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_quota_usage_quota_day_pk" PRIMARY KEY("quota","day")
);
--> statement-breakpoint
ALTER TABLE "discovery_results" ALTER COLUMN "resource_ids" SET DEFAULT '{}'::uuid[];--> statement-breakpoint
ALTER TABLE "discovery_results" ADD COLUMN "status" "discovery_pool_status" DEFAULT 'analysing' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_results" ADD COLUMN "candidate_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_results" ADD COLUMN "analysed_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_results" ADD COLUMN "video_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_cards" ADD COLUMN "confidence" real NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_cards" ADD COLUMN "evidence" text NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_cards" ADD COLUMN "status" "resource_card_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_cards" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "page_age" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "failed_checks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "metadata_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "web_search_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_cards" ADD CONSTRAINT "resource_cards_confidence_range" CHECK ("resource_cards"."confidence" between 0 and 1);