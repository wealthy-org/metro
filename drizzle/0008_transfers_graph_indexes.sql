CREATE INDEX "idx_transfers_ts" ON "token_transfers" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_transfers_from" ON "token_transfers" USING btree ("from_address","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_transfers_to" ON "token_transfers" USING btree ("to_address","ts" DESC NULLS LAST);