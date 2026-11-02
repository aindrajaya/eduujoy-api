CREATE TABLE "topic_concept_maps" (
	"topic_id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"prompt_version" text NOT NULL,
	"map" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topic_concept_maps" ADD CONSTRAINT "topic_concept_maps_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;