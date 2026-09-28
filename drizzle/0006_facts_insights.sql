CREATE TABLE "facts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" varchar(128) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"value" numeric NOT NULL,
	"n" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"rule" varchar(64) NOT NULL,
	"status" varchar(24) NOT NULL,
	"text" text NOT NULL,
	"facts_ref" jsonb NOT NULL,
	"severity" varchar(16) NOT NULL,
	"n" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"evidence_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_facts_key_window" ON "facts" USING btree ("key","window_start","window_end");--> statement-breakpoint
CREATE INDEX "idx_facts_computed" ON "facts" USING btree ("computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_insights_created" ON "insights" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_insights_expires" ON "insights" USING btree ("expires_at");