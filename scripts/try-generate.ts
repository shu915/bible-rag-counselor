// 【試作用】評価の例題(eval/search-eval.json)の相談文と、指定した3つの段落 id で、解説と結論を作って、目で読む。
// 本番の流れ(書き換え → 検索 → 選択 → 生成)の「生成」だけを試す。選択は、人が id を渡す。
//
// 使い方:
//   npm run try:generate -- --case q05 --ids Lam.1.1-22,Matt.5.3-12,2Cor.7.5-16
//
// 表示するのは、例題(自作の文)・段落 id・生成した解説と結論・トークン数。聖句の本文は、出さない。
// 相談文は、例題だけ(任意の文は受け付けない)。実際のユーザーの入力は、本番でも開発でも、ログに出さない。
// DB は読むだけ。OpenRouter を呼ぶ(1回 約 $0.01〜0.02)。
import * as fs from "node:fs";
import * as path from "node:path";
import { Pool } from "pg";
import { generateCounsel } from "../src/lib/generate-counsel";
import { buildContent, describeTarget, paragraphSchema } from "./insert-lib";
import { evalFileSchema } from "./eval-lib";

// drizzle.config.ts と同じく、.env.local を読む。すでにある環境変数は上書きしない
const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if (!isMissingFile(error)) throw error;
}

function argValue(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (!value) throw new Error(`${name} を指定してください(使い方は、ファイルの先頭)`);
  return value;
}

async function main(): Promise<void> {
  const caseId = argValue("--case");
  const ids = argValue("--ids")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL が未設定です");
  console.log(`接続先: ${describeTarget(databaseUrl).label}`);

  const raw: unknown = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "eval", "search-eval.json"), "utf-8"),
  );
  const evalCase = evalFileSchema.parse(raw).cases.find((c) => c.id === caseId);
  if (!evalCase) throw new Error(`例題が見つかりません: ${caseId}`);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query<{ id: string; verses: unknown }>(
      "SELECT id, verses FROM paragraphs WHERE id = ANY($1)",
      [ids],
    );
    const byId = new Map(rows.map((row) => [row.id, row.verses]));
    const passages = ids.map((id) => {
      const verses = byId.get(id);
      if (verses === undefined) throw new Error(`DB にない段落です: ${id}`);
      return { id, text: buildContent({ verses: paragraphSchema.shape.verses.parse(verses) }) };
    });

    console.log(`\n■ ${evalCase.id}「${evalCase.query}」`);
    console.log(`  箇所(この順に、受け止める・慰める・励ます): ${ids.join(" → ")}\n`);

    const startedAt = Date.now();
    const result = await generateCounsel(evalCase.query, passages);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (result.preface) console.log(`【前置き】${result.preface}\n`);
    for (const item of result.commentaries) {
      console.log(`【${item.id}】\n${item.commentary}\n`);
    }
    console.log(`【結論】\n${result.conclusion}\n`);
    console.log(
      `crisis: ${result.crisis} / ${seconds}秒 / トークン: 入力 ${result.usage.promptTokens} 出力 ${result.usage.completionTokens}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // 例外のメッセージには、入力や返答の中身が入らない(OpenRouterError・GenerationError)
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "失敗しました");
  process.exitCode = 1;
});
