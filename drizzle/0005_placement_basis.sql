CREATE TYPE "public"."placement_basis" AS ENUM('items', 'self_report');--> statement-breakpoint
ALTER TABLE "placements" ADD COLUMN "basis" "placement_basis" DEFAULT 'items' NOT NULL;