CREATE TABLE "paragraphs" (
	"id" text PRIMARY KEY NOT NULL,
	"book_key" text NOT NULL,
	"book_name" text NOT NULL,
	"testament" text NOT NULL,
	"book_order" smallint NOT NULL,
	"chapter" smallint NOT NULL,
	"verse_start" smallint NOT NULL,
	"verse_end" smallint NOT NULL,
	"verses" jsonb NOT NULL,
	"content_tokens" text NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content_tokens)) STORED NOT NULL,
	"embedding" vector(1536) NOT NULL,
	CONSTRAINT "paragraphs_testament_check" CHECK ("paragraphs"."testament" IN ('OT', 'NT')),
	CONSTRAINT "paragraphs_book_order_check" CHECK ("paragraphs"."book_order" BETWEEN 1 AND 66),
	CONSTRAINT "paragraphs_chapter_check" CHECK ("paragraphs"."chapter" >= 1),
	CONSTRAINT "paragraphs_verse_range_check" CHECK ("paragraphs"."verse_start" <= "paragraphs"."verse_end")
);
--> statement-breakpoint
CREATE INDEX "paragraphs_search_tsv_idx" ON "paragraphs" USING gin ("search_tsv");