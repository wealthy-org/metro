CREATE TABLE "agg_day" (
	"date" date NOT NULL,
	"action" varchar(32) NOT NULL,
	"subsidy_class" varchar(24) NOT NULL,
	"tx_count" integer NOT NULL,
	"gas_used" numeric NOT NULL,
	"fee_usd_avg" numeric NOT NULL,
	"fee_usd_median" numeric NOT NULL,
	"active_wallets" integer NOT NULL,
	"retained_wallets" integer,
	"failed_tx_count" integer NOT NULL,
	CONSTRAINT "agg_day_date_action_subsidy_class_pk" PRIMARY KEY("date","action","subsidy_class")
);
--> statement-breakpoint
CREATE TABLE "agg_minute" (
	"ts" timestamp with time zone NOT NULL,
	"action" varchar(32) NOT NULL,
	"tx_count" integer NOT NULL,
	"gas_used" numeric NOT NULL,
	"fee_usd_sum" numeric NOT NULL,
	"fee_usd_median" numeric NOT NULL,
	"wallets" integer NOT NULL,
	CONSTRAINT "agg_minute_ts_action_pk" PRIMARY KEY("ts","action")
);
--> statement-breakpoint
CREATE INDEX "idx_agg_minute_ts" ON "agg_minute" USING btree ("ts" DESC NULLS LAST);