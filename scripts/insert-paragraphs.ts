// data/bible-paragraphs.json の全段落を、分かち書き・エンベディングして、paragraphs テーブルに入れる。
//
// 使い方(プロジェクトのルートから):
//   npm run db:insert                       全段落(すでに入っている id は飛ばす)
//   npm run db:insert -- --limit 20         先頭の20件だけ(試しに動かす)
//   npm run db:insert -- --allow-remote     ローカル以外(本番の Neon など)に入れるとき
//
// - 途中で失敗しても、もう一度実行すれば、入っていない段落から続きをやる(1回の送信ごとに INSERT する)
// - 表示するのは、件数と進み具合だけ(本文は出さない)
import * as fs from "node:fs";
import * as path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { paragraphs } from "../src/db/schema";
import { EMBEDDING_MODEL, embedTexts } from "../src/lib/openrouter";
import { tokenizeToString } from "../src/lib/tokenizer";
import {
  buildContent,
  describeTarget,
  isLocalHost,
  makeBatches,
  paragraphsFileSchema,
  type ParagraphInput,
} from "./insert-lib";

// 1回の送信の上限。件数と、文字数の合計(日本語は、約1文字 = 約1トークン)
const BATCH_MAX_COUNT = 100;
const BATCH_MAX_CHARS = 100_000;

// drizzle.config.ts と同じく、.env.local を読む。すでにある環境変数は上書きしない
const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if (!isMissingFile(error)) throw error;
}

function parseArgs(argv: string[]): { limit: number | undefined; allowRemote: boolean } {
  const allowRemote = argv.includes("--allow-remote");
  const limitIndex = argv.indexOf("--limit");
  if (limitIndex === -1) return { limit: undefined, allowRemote };
  const limit = Number(argv[limitIndex + 1]);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit には、1以上の整数を指定してください");
  }
  return { limit, allowRemote };
}

async function main(): Promise<void> {
  const { limit, allowRemote } = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL が未設定です(.env.local か、環境変数で渡してください)");
  }
  const target = describeTarget(databaseUrl);
  console.log(`接続先: ${target.label}`);
  if (!isLocalHost(target.host) && !allowRemote) {
    // 本番に、うっかり入れないための確認
    throw new Error(
      "接続先がローカルではありません。確認してから、--allow-remote を付けて実行してください",
    );
  }

  // 1. JSON を読んで検証する(外から来るデータ)
  const jsonPath = path.join(process.cwd(), "data", "bible-paragraphs.json");
  const raw: unknown = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const all = paragraphsFileSchema.parse(raw);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db = drizzle(pool);

    // 2. すでに入っている id を飛ばす(途中から再開できる)
    const existing = new Set(
      (await db.select({ id: paragraphs.id }).from(paragraphs)).map((r) => r.id),
    );
    const todo = all.filter((p) => !existing.has(p.id)).slice(0, limit);
    console.log(
      `全 ${all.length} 段落 / 入っている ${existing.size} / これから入れる ${todo.length}(モデル: ${EMBEDDING_MODEL})`,
    );
    if (todo.length === 0) return;

    // 3. まとめて、分かち書き → エンベディング → INSERT
    const batches = makeBatches(todo, (p) => buildContent(p).length, {
      maxCount: BATCH_MAX_COUNT,
      maxSize: BATCH_MAX_CHARS,
    });
    let done = 0;
    for (const batch of batches) {
      await insertBatch(db, batch);
      done += batch.length;
      console.log(`${done} / ${todo.length}`);
    }
    console.log("完了");
  } finally {
    await pool.end();
  }
}

async function insertBatch(
  db: ReturnType<typeof drizzle>,
  batch: readonly ParagraphInput[],
): Promise<void> {
  const contents = batch.map(buildContent);
  const tokens = await Promise.all(contents.map((content) => tokenizeToString(content)));
  const embeddings = await embedTexts(contents);

  await db
    .insert(paragraphs)
    .values(
      batch.map((p, i) => ({
        id: p.id,
        bookKey: p.book_key,
        bookName: p.book_name,
        testament: p.testament,
        bookOrder: p.book_order,
        chapter: p.chapter,
        verseStart: p.verse_start,
        verseEnd: p.verse_end,
        verses: p.verses,
        contentTokens: tokens[i],
        embedding: embeddings[i],
      })),
    )
    // 並行して2つ動かしたときなどに、同じ id が来ても、止まらずに飛ばす
    .onConflictDoNothing();
}

main().catch((error: unknown) => {
  // 本文やキーを出さないよう、メッセージだけ表示する
  console.error(error instanceof Error ? error.message : "不明なエラー");
  process.exit(1);
});
