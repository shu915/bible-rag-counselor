// DB 投入スクリプト(insert-paragraphs.ts)の、通信や DB を使わない部分。テストしやすいように分けてある。
import { z } from "zod";

// data/bible-paragraphs.json の1段落分。外から来るデータなので、読み込んだら検証する
export const paragraphSchema = z.object({
  id: z.string().min(1),
  book_key: z.string().min(1),
  book_name: z.string().min(1),
  testament: z.enum(["OT", "NT"]),
  book_order: z.number().int().min(1).max(66),
  chapter: z.number().int().min(1),
  verse_start: z.number().int().min(1),
  verse_end: z.number().int().min(1),
  verses: z
    .array(z.object({ verse: z.number().int(), verse_end: z.number().int(), text: z.string() }))
    .min(1),
});
export const paragraphsFileSchema = z.array(paragraphSchema);
export type ParagraphInput = z.infer<typeof paragraphSchema>;

// 検索・ベクトル化に使う本文。節を、そのままつなぐ(日本語なので、区切りは入れない)。
// 書名・章節のプレフィックスは付けない(付ける案は、動いてから比べる)
export function buildContent(paragraph: Pick<ParagraphInput, "verses">): string {
  return paragraph.verses.map((verse) => verse.text).join("");
}

// API に送る単位に分ける。件数と、文字数の合計の両方に上限がある
// (長い段落が100件そろうと、1回のリクエストが大きくなりすぎるため)
export function makeBatches<T>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  limits: { maxCount: number; maxSize: number },
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentSize = 0;
  for (const item of items) {
    const size = sizeOf(item);
    const full =
      current.length >= limits.maxCount ||
      (current.length > 0 && currentSize + size > limits.maxSize);
    if (full) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(item);
    currentSize += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// 接続先の表示用(パスワードは出さない)。URL の形式が不正でも、元の文字列は例外に含めない
export function describeTarget(databaseUrl: string): { host: string; label: string } {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL の形式が不正です(値は表示しません)");
  }
  return { host: url.hostname, label: `${url.hostname}:${url.port || "5432"}${url.pathname}` };
}

// ローカルの DB かどうか。ローカル以外(本番の Neon など)に書き込むときは、明示の許可を求める
export function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
