CREATE TABLE "analyst_answers" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"question_hash" varchar(64) NOT NULL,
	"facts_ref" jsonb NOT NULL,
	"answer" text NOT NULL,
	"model_used" varchar(64) NOT NULL,
	"validated" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"daily_ask_count" integer DEFAULT 0 NOT NULL,
	"last_ask_date" date DEFAULT CURRENT_DATE NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_answers_hash" ON "analyst_answers" USING btree ("question_hash");