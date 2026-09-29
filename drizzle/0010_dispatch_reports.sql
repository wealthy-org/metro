CREATE TABLE "dispatch" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"range_label" varchar(64) NOT NULL,
	"body_md" text NOT NULL,
	"facts_ref" jsonb NOT NULL,
	"model_used" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_dispatch_created" ON "dispatch" USING btree ("created_at" DESC NULLS LAST);