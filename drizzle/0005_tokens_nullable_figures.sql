ALTER TABLE "tokens" ALTER COLUMN "holders" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tokens" ALTER COLUMN "holders" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ALTER COLUMN "supply" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tokens" ALTER COLUMN "supply" DROP NOT NULL;--> statement-breakpoint
-- No code has ever written these columns; the zeros are defaults, not measurements (audit A4).
UPDATE "tokens" SET "holders" = NULL, "supply" = NULL;
