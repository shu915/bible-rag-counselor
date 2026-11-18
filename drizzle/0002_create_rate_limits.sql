CREATE TABLE "rate_limits" (
	"ip_hash" text NOT NULL,
	"day" date NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limits_ip_hash_day_pk" PRIMARY KEY("ip_hash","day"),
	CONSTRAINT "rate_limits_count_check" CHECK ("rate_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "rate_limits_day_idx" ON "rate_limits" USING btree ("day");