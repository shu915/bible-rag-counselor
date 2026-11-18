// テーブル定義(Drizzle)。列の意味は CLAUDE.md の「DB 投入」を参照。
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  vector,
} from "drizzle-orm/pg-core";

// Drizzle に標準の tsvector 型がないので、型名だけ教える。
// この列は DB が生成するので、アプリが値を入れることはない(読むときも使わない)。
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// 1段落 = 1行。検索(ベクトル・全文)の単位。
export const paragraphs = pgTable(
  "paragraphs",
  {
    id: text("id").primaryKey(), // 例: "Matt.6.25-34"。引用の出典としてそのまま確認できる
    bookKey: text("book_key").notNull(), // 例: "Matt"
    bookName: text("book_name").notNull(), // 例: "マタイによる福音書"
    testament: text("testament").notNull(), // "OT"(旧約) / "NT"(新約)。絞り込み用
    bookOrder: smallint("book_order").notNull(), // 1〜66。並べ替え用
    chapter: smallint("chapter").notNull(),
    verseStart: smallint("verse_start").notNull(),
    verseEnd: smallint("verse_end").notNull(),
    // 表示用の節ごとの本文。検索には使わない(本文は、これを結合して投入時に作る)
    verses: jsonb("verses").notNull(),
    // 分かち書きした文字列(名詞・動詞・形容詞の原形を空白区切り)
    contentTokens: text("content_tokens").notNull(),
    // content_tokens から DB が自動で作る全文検索用の列(入れ忘れ・食い違いを防ぐ)
    searchTsv: tsvector("search_tsv")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('simple'::regconfig, content_tokens)`),
    // text-embedding-3-small の次元数。5,709行なので、ベクトルの索引は張らず全件スキャンにする
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  },
  (t) => [
    index("paragraphs_search_tsv_idx").using("gin", t.searchTsv),
    check("paragraphs_testament_check", sql`${t.testament} IN ('OT', 'NT')`),
    check("paragraphs_book_order_check", sql`${t.bookOrder} BETWEEN 1 AND 66`),
    check("paragraphs_chapter_check", sql`${t.chapter} >= 1`),
    check("paragraphs_verse_range_check", sql`${t.verseStart} <= ${t.verseEnd}`),
  ],
);

// 回数制限の記録(docs/rate-limit.md)。**IP のハッシュ・日付・回数だけ**。IP は生で持たない。
// 悩みの内容・AI の返答は、一切入れない(入力と返答を保存しない方針と両立させる)。
// 日付は、日本時間(Asia/Tokyo)の1日。古い行は、書き込みのたびに消す(数日分だけ持つ)。
export const rateLimits = pgTable(
  "rate_limits",
  {
    ipHash: text("ip_hash").notNull(), // IP を、秘密の値(RATE_LIMIT_SALT)で HMAC-SHA256 にした 16進数
    day: date("day").notNull(), // 日本時間の日付
    count: integer("count").notNull(), // その日に使った回数
  },
  (t) => [
    primaryKey({ columns: [t.ipHash, t.day] }),
    index("rate_limits_day_idx").on(t.day),
    check("rate_limits_count_check", sql`${t.count} >= 0`),
  ],
);
