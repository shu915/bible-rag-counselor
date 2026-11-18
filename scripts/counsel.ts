// 【開発用】ターミナルで、悩み事・愚痴・弱音・懺悔を入力すると、聖書の3つの箇所と、解説と、結論が返る。
// 本番の流れ(危機の検出 → 書き換え → 検索 → 選択 → 生成)を、画面なしで通して試す。
//
// 使い方: npm run counsel          / 検索の内訳: -- --debug / 引用を段落の全部で(核心は太字): -- --full
//   悩みは、対話の入力で受ける(コマンドの引数にしないので、シェルの履歴に残らない)。空の行で終了する。
//
// 入力も、返答も、ファイルにも、DB にも保存しない。表示するのは、自分の端末の画面だけ。
// DB は読むだけ。OpenRouter を呼ぶ(1回 約 $0.03)。
import * as readline from "node:readline/promises";
import { Pool } from "pg";
import { detectCrisis } from "../src/lib/crisis";
import { CRISIS_MESSAGE_LINES } from "../src/lib/crisis-message";
import { MAX_INPUT_CHARS } from "../src/lib/counsel-schema";
import { generateCounsel } from "../src/lib/generate-counsel";
import { buildQuote } from "../src/lib/quote";
import { searchPassages, type Queryable, type SearchDebug } from "../src/lib/search-passages";
import { MAX_QUERY_CHARS } from "../src/lib/tokenizer";
import { describeTarget } from "./insert-lib";

// drizzle.config.ts と同じく、.env.local を読む。すでにある環境変数は上書きしない
const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if (!isMissingFile(error)) throw error;
}

// 相談1件ぶんの全体の締め切り(開発用。本番は、Vercel の関数の時間に合わせて決める)
const DEADLINE_MS = 90_000;

// 命の危険のときの、固定の表示(画面と共通。src/lib/crisis-message.ts。窓口の名前と番号は、公開前に人が確認して入れる)
const CRISIS_MESSAGE = CRISIS_MESSAGE_LINES.join("\n");

// 検索の内訳(--debug)。順位・コサイン類似度・どう扱われたか。書き換えた検索文を含むので、端末にだけ出す
function printDebug(debug: SearchDebug): void {
  console.log("\n■ 検索の内訳(--debug)");
  console.log("  書き換えた検索文(AI が作った):");
  debug.rewrites.forEach((q, i) => console.log(`    ${i + 1}) ${q}`));
  console.log("\n  候補(RRF の順)。コサイン類似度は、検索文のベクトルとの類似度(1 に近いほど近い)");
  console.log("  順位 採用 LLM 重複 ベクトル 全文  コサイン 文字数 id");
  for (const c of debug.candidates) {
    const cell = (n: number | undefined, width: number): string =>
      (n === undefined ? "-" : String(n)).padStart(width);
    console.log(
      `  ${String(c.rrfRank).padStart(3)}   ${c.adopted ? "◎" : " "}   ${c.pickedByLlm ? "○" : " "}   ${c.skippedAsDuplicate ? "×" : " "}   ${cell(c.vectorRank, 5)} ${cell(c.ftsRank, 4)}  ${c.cosine === undefined ? "   -  " : c.cosine.toFixed(3)} ${String(c.chars).padStart(5)} ${c.id}`,
    );
  }
  console.log("  (◎=採用 ○=LLM が選んだ ×=並行記事などの重複で除外 / 文字数は DB の本文)");

  console.log("\n■ 採用した 3 件が、DB から出た本物である証拠(AI は、この値を知らない)");
  console.log(
    "  id は、聖書の番号なので、AI にも書ける。証拠にならない。代わりに、DB だけが持つ値を出す:",
  );
  for (const proof of debug.proofs) {
    const head = proof.embeddingHead.map((n) => n.toFixed(4)).join(", ");
    console.log(`  ${proof.id}`);
    console.log(`    DB の行の位置(ctid): ${proof.ctid} / ベクトルの先頭 3 次元: [${head}]`);
    console.log(
      `    本文の MD5  DB の側: ${proof.dbMd5}  /  いま表示した本文: ${proof.shownMd5}  → ${proof.matches ? "一致(1字も変わっていない)" : "**不一致**"}`,
    );
  }
}

// 端末の太字・薄い字(ANSI)。--full で、段落の全部を出すとき、核心の節を太字にして、目が行くようにする
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

async function consult(
  db: Queryable,
  consultation: string,
  options: { debug: boolean; full: boolean },
): Promise<void> {
  const { debug, full } = options;
  // 1. 命の危険を示す語は、AI を呼ぶ前に、キーワードで止める
  if (detectCrisis(consultation)) {
    console.log(`\n${CRISIS_MESSAGE}`);
    return;
  }

  const startedAt = Date.now();
  const signal = AbortSignal.timeout(DEADLINE_MS);

  // 2. 書き換え → 検索 → 選択
  const found = await searchPassages(db, consultation, { signal, debug });
  // 3. 解説と結論
  const counsel = await generateCounsel(
    consultation,
    found.passages.map((p) => ({ id: p.id, text: p.text, verses: p.verses })),
    { signal },
  );

  // 補助の防御: LLM が、命に関わる内容だと判断したら、解説を出さずに、固定の表示にする
  if (counsel.crisis) {
    console.log(`\n${CRISIS_MESSAGE}`);
    return;
  }

  if (counsel.preface) console.log(`\n${counsel.preface}`);
  for (const passage of found.passages) {
    const item = counsel.commentaries.find((c) => c.id === passage.id);
    // 引用は、AI が選んだ核心の節(範囲がなければ、先頭から短く)。本文は、必ず DB の節から取る
    const quote = buildQuote(passage.verses, item?.quote, item?.core);
    const label = quote.partial ? `${quote.from}-${quote.to}節` : "全文";
    console.log(`
■ ${passage.reference}(${passage.id})  引用: ${label}`);
    // 意味が通じる範囲を出して、その中の核心の節を太字にする。--full では、段落の全部を出し、範囲の外は薄くする。
    // 本文は、必ず DB の節から(AI は、節の番号だけを選ぶ)
    const shown = full ? passage.verses : quote.verses;
    for (const v of shown) {
      const inQuote = v.verse_end >= quote.from && v.verse <= quote.to;
      const core =
        quote.core !== undefined && v.verse_end >= quote.core.from && v.verse <= quote.core.to;
      const style = core ? BOLD : inQuote ? "" : DIM;
      console.log(`  ${style}${v.text}${style ? RESET : ""}`);
    }
    if (!full && quote.partial) {
      const last = passage.verses[passage.verses.length - 1]?.verse_end;
      console.log(`  (この段落は ${passage.verses[0]?.verse}-${last}節。全部を見るには --full)`);
    }
    console.log(`\n  ${item?.commentary ?? ""}`);
  }
  console.log(`\n■ 結論\n  ${counsel.conclusion}`);

  if (found.debug) printDebug(found.debug);

  const prompt = found.usage.promptTokens + (counsel.usage.promptTokens ?? 0);
  const completion = found.usage.completionTokens + (counsel.usage.completionTokens ?? 0);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n(${seconds}秒 / トークン: 入力 ${prompt} 出力 ${completion})`);
}

async function main(): Promise<void> {
  // --debug: 検索の内訳(順位・コサイン類似度など)も表示する
  const debug = process.argv.includes("--debug");
  // --full: 引用を、核心の節だけでなく、段落の全部で出す(核心の節は太字)
  const full = process.argv.includes("--full");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL が未設定です");
  console.log(`接続先: ${describeTarget(databaseUrl).label}`);
  console.log(
    `悩み事・愚痴・弱音・懺悔を、書いてください(${MAX_INPUT_CHARS}字まで)。入力は、保存されません。`,
  );

  const pool = new Pool({ connectionString: databaseUrl });
  const db: Queryable = {
    async query(text, values) {
      const result = await pool.query(text, values);
      return { rows: result.rows };
    },
  };
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 0,
  });

  try {
    for (;;) {
      let line: string;
      try {
        line = (await rl.question("\n> ")).trim();
      } catch {
        break; // 入力が閉じた(Ctrl-D など)
      }
      if (line === "") break;
      if (line.length > Math.min(MAX_INPUT_CHARS, MAX_QUERY_CHARS)) {
        console.log(`長すぎます(${MAX_INPUT_CHARS}字まで)。短くして、もう一度。`);
        continue;
      }
      try {
        await consult(db, line, { debug, full });
      } catch (error) {
        // 例外のメッセージには、入力や返答の中身が入らない(OpenRouterError・GenerationError・SearchError)
        console.error(
          error instanceof Error
            ? `\n失敗しました: ${error.name}: ${error.message}`
            : "\n失敗しました",
        );
      }
    }
  } finally {
    rl.close();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "失敗しました");
  process.exitCode = 1;
});
