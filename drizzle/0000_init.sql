CREATE TABLE "blocks" (
	"number" bigint PRIMARY KEY NOT NULL,
	"hash" varchar(66) NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"gas_used" numeric NOT NULL,
	"gas_limit" numeric NOT NULL,
	"base_fee" numeric,
	"tx_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "blocks_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "ingest_cursor" (
	"name" varchar(32) PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "known_contracts" (
	"address" varchar(42) PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"label" varchar(64) NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "pons_launches" (
	"token_address" varchar(42) PRIMARY KEY NOT NULL,
	"creator_address" varchar(42) NOT NULL,
	"block" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"params" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"ts" timestamp with time zone PRIMARY KEY NOT NULL,
	"eth_usd" numeric NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_transfers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tx_hash" varchar(66) NOT NULL,
	"log_index" integer NOT NULL,
	"token_address" varchar(42) NOT NULL,
	"from_address" varchar(42) NOT NULL,
	"to_address" varchar(42) NOT NULL,
	"amount" numeric NOT NULL,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"address" varchar(42) PRIMARY KEY NOT NULL,
	"symbol" varchar(32),
	"name" varchar(128),
	"decimals" integer DEFAULT 18 NOT NULL,
	"is_pons" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"holders" integer DEFAULT 0 NOT NULL,
	"supply" numeric DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "txs" (
	"hash" varchar(66) NOT NULL,
	"block" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"from_address" varchar(42) NOT NULL,
	"to_address" varchar(42),
	"value" numeric DEFAULT '0' NOT NULL,
	"gas_used" numeric NOT NULL,
	"gas_price" numeric NOT NULL,
	"fee_eth" numeric NOT NULL,
	"fee_usd" numeric NOT NULL,
	"status" smallint NOT NULL,
	"method" varchar(64),
	"action" varchar(32) NOT NULL,
	"subsidy_class" varchar(24) NOT NULL,
	CONSTRAINT "txs_hash_ts_pk" PRIMARY KEY("hash","ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
ALTER TABLE "pons_launches" ADD CONSTRAINT "pons_launches_token_address_tokens_address_fk" FOREIGN KEY ("token_address") REFERENCES "public"."tokens"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "txs" ADD CONSTRAINT "txs_block_blocks_number_fk" FOREIGN KEY ("block") REFERENCES "public"."blocks"("number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_blocks_ts" ON "blocks" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_transfers_token_ts" ON "token_transfers" USING btree ("token_address","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_transfers_tx" ON "token_transfers" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_transfers_log" ON "token_transfers" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "idx_txs_from" ON "txs" USING btree ("from_address","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_txs_to" ON "txs" USING btree ("to_address","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_txs_action" ON "txs" USING btree ("action","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_txs_subsidy" ON "txs" USING btree ("subsidy_class","ts" DESC NULLS LAST);