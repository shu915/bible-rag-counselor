// 検索の評価。eval/search-eval.json の各相談文で検索して、正解の段落が何位に出るかを測る。
//
// 使い方(プロジェクトのルートから):
//   npm run eval:search                                  段落そのままのベクトル検索(ベースライン)
//   npm run eval:search -- --method rewrite              相談文を、LLM で口語訳の言い回しに書き換えてから検索
//   npm run eval:search -- --method rewrite+orig         書き換えた文と、元の相談文の両方で検索して、RRF で統合
//   npm run eval:search -- --method fts                  書き換えて、全文検索だけ
//   npm run eval:search -- --method hybrid               書き換えて、ベクトル + 全文を RRF で統合
//   npm run eval:search -- --method select               ハイブリッドの候補から、LLM に3件を選ばせる(本番の形)
//   --candidates N / --chars C / --show-top N / --show-text / --fresh は、ファイルの下の main を参照
//
// 表示するのは、問いの番号・順位・集計と、書き換えた検索文(例題は自作の文)だけ(聖句の本文は出さない)。
// DB は読むだけで、書き込まない。相談文のエンベディングと書き換えのために、OpenRouter を呼ぶ(17問で、1円未満)。
import * as fs from "node:fs";
import * as path from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { embedTexts } from "../src/lib/openrouter";
import { buildTsQuery } from "../src/lib/fts-query";
import { rewriteQuery, type RewriteResult } from "../src/lib/rewrite-query";
import { selectPassages } from "../src/lib/select-passages";
import { tokenizeQuery } from "../src/lib/tokenizer";
import { buildContent, describeTarget, paragraphSchema } from "./insert-lib";
import { evalFileSchema, firstRank, rrfFuse, summarize } from "./eval-lib";

// 書き換えの保存ファイルの形(外から来るデータなので、検証する)
const rewriteCacheSchema = z.record(
  z.string(),
  z.object({
    queries: z.array(z.string()),
    usage: z.object({
      promptTokens: z.number().optional(),
      completionTokens: z.number().optional(),
    }),
  }),
);

// 順位を測る範囲。ここに入らなければ「圏外」(順位の表示は ">N")
const MAX_RANK = 100;

// drizzle.config.ts と同じく、.env.local を読む。すでにある環境変数は上書きしない
const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if (!isMissingFile(error)) throw error;
}

// 1つのベクトルに近い順の、段落 id(上位 MAX_RANK 件)を返す
type Ranker = (vector: number[], pool: Pool) => Promise<string[]>;

const paragraphRanker: Ranker = async (vector, pool) => {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM paragraphs ORDER BY embedding <=> $1::vector LIMIT $2",
    [`[${vector.join(",")}]`, MAX_RANK],
  );
  return rows.map((row) => row.id);
};

// 検索の対象。どう順位をつけるか(いまは、段落のベクトル検索だけ)。
// 相談文は、文書側(DB 投入)と同じモデル(EMBEDDING_MODEL)でベクトルにする
interface Target {
  rank: Ranker;
}

const paragraphTarget: Target = { rank: paragraphRanker };

// 1つの相談文の検索結果。ids は順位つきの段落 id、note は表示用のメモ(書き換えた検索文など)
interface Outcome {
  ids: string[];
  note?: string;
}

// 費用の見積もり用(LLM で使ったトークン数の合計。書き換えと、選択)
const usageTotal = { promptTokens: 0, completionTokens: 0 };

// 書き換えの結果は、毎回少し違う(±10 ポイント動く)ので、ファイルに保存して使い回す。
// こうすると、「選ばせる側」などの違いだけを、公平に比べられる。--fresh で、保存を使わずに、書き換え直す。
// (保存するのは、例題の相談文と、書き換えた検索文だけ。.eval-cache/ は git に入れない)
const CACHE_PATH = path.join(process.cwd(), ".eval-cache", "rewrites.json");
let useCache = true;

function readRewriteCache(): z.infer<typeof rewriteCacheSchema> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
    return rewriteCacheSchema.parse(raw);
  } catch {
    return {};
  }
}

async function cachedRewrite(query: string): Promise<RewriteResult> {
  if (useCache) {
    const hit = readRewriteCache()[query];
    if (hit) return { queries: hit.queries, usage: { promptTokens: 0, completionTokens: 0 } };
  }
  const result = await rewriteQuery(query);
  usageTotal.promptTokens += result.usage.promptTokens ?? 0;
  usageTotal.completionTokens += result.usage.completionTokens ?? 0;
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ ...readRewriteCache(), [query]: result }, null, 2));
  return result;
}

// 検索の方法。相談文の一覧から、相談文ごとの結果を返す
type SearchMethod = (queries: readonly string[], pool: Pool) => Promise<Outcome[]>;

const directSearch =
  (target: Target): SearchMethod =>
  async (queries, pool) => {
    const vectors = await embedTexts(queries);
    return Promise.all(vectors.map(async (vector) => ({ ids: await target.rank(vector, pool) })));
  };

// 相談文を、LLM で口語訳の言い回しの検索文に書き換えてから検索する。
// 検索文が複数あるので、それぞれの順位つきリストを、RRF で1つにまとめる。includeOriginal なら、元の相談文も1つとして足す
const rewriteSearch =
  (target: Target, includeOriginal: boolean): SearchMethod =>
  async (queries, pool) => {
    const outcomes: Outcome[] = [];
    for (const query of queries) {
      const { queries: rewrites } = await cachedRewrite(query);

      const searchTexts = includeOriginal ? [query, ...rewrites] : rewrites;
      const vectors = await embedTexts(searchTexts);
      const lists = await Promise.all(vectors.map((vector) => target.rank(vector, pool)));
      outcomes.push({
        ids: rrfFuse(lists).slice(0, MAX_RANK),
        note: `書き換え: ${rewrites.join(" / ")}`,
      });
    }
    return outcomes;
  };

// 全文検索(分かち書きしたトークンの OR)での、順位つきの段落 id。使えるトークンがなければ空
async function ftsRank(text: string, pool: Pool): Promise<string[]> {
  const query = buildTsQuery(await tokenizeQuery(text));
  if (!query) return [];
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM paragraphs WHERE search_tsv @@ to_tsquery('simple', $1) ORDER BY ts_rank(search_tsv, to_tsquery('simple', $1), 1) DESC, id LIMIT $2",
    [query, MAX_RANK],
  );
  return rows.map((row) => row.id);
}

// 相談文を書き換えて、書き換えた検索文それぞれで、全文検索(と、withVector ならベクトル検索)をして、RRF で1つにまとめる。
// withVector が false なら、全文検索だけ(全文検索が、単独でどれくらい効くかを見るため)
const rewriteFtsSearch =
  (target: Target, withVector: boolean): SearchMethod =>
  async (queries, pool) => {
    const outcomes: Outcome[] = [];
    for (const query of queries) {
      const { queries: rewrites } = await cachedRewrite(query);

      const ftsLists = await Promise.all(rewrites.map((text) => ftsRank(text, pool)));
      const vectorLists = withVector
        ? await Promise.all((await embedTexts(rewrites)).map((vector) => target.rank(vector, pool)))
        : [];
      outcomes.push({
        ids: rrfFuse([...vectorLists, ...ftsLists]).slice(0, MAX_RANK),
        note: `書き換え: ${rewrites.join(" / ")} / 全文の該当数: ${ftsLists.map((l) => l.length).join(", ")}`,
      });
    }
    return outcomes;
  };

// 候補の数と、候補1件あたりの本文の長さ(--candidates / --chars で変える)
const selectConfig = { candidates: 15, chars: 150 };

// ハイブリッドで候補を取って、LLM に、相談に合う3件を選ばせる。
// 返す順位は「LLM が選んだ3件(選んだ順)→ 残りの候補(ハイブリッドの順)」。上位3件の成績が、LLM の選択の成績になる
const selectSearch: SearchMethod = async (queries, pool) => {
  const hybrid = rewriteFtsSearch(paragraphTarget, true);
  const outcomes: Outcome[] = [];
  for (const query of queries) {
    const [base] = await hybrid([query], pool);
    const baseIds = base?.ids ?? [];
    const candidateIds = baseIds.slice(0, selectConfig.candidates);

    const { rows } = await pool.query<{ id: string; verses: unknown }>(
      "SELECT id, verses FROM paragraphs WHERE id = ANY($1)",
      [candidateIds],
    );
    const byId = new Map(rows.map((row) => [row.id, row.verses]));
    const candidates = candidateIds.flatMap((id) => {
      const verses = byId.get(id);
      if (verses === undefined) return [];
      return [{ id, text: buildContent({ verses: paragraphSchema.shape.verses.parse(verses) }) }];
    });

    const { ids: picked, usage } = await selectPassages(query, candidates, {
      maxCharsPerCandidate: selectConfig.chars,
    });
    usageTotal.promptTokens += usage.promptTokens ?? 0;
    usageTotal.completionTokens += usage.completionTokens ?? 0;

    outcomes.push({
      ids: [...picked, ...baseIds.filter((id) => !picked.includes(id))],
      note: `${base?.note ?? ""} / 候補${candidateIds.length}件から選択: ${picked.join(", ")}`,
    });
  }
  return outcomes;
};

// 方法の名前から、検索の関数を選ぶ。
// "vector" / "rewrite" / "rewrite+orig" / "fts" / "hybrid" / "select"
function resolveMethod(name: string): SearchMethod | undefined {
  if (name === "vector") return directSearch(paragraphTarget);
  if (name === "select") return selectSearch;
  if (name === "fts") return rewriteFtsSearch(paragraphTarget, false);
  if (name === "hybrid") return rewriteFtsSearch(paragraphTarget, true);
  if (name === "rewrite") return rewriteSearch(paragraphTarget, false);
  if (name === "rewrite+orig") return rewriteSearch(paragraphTarget, true);
  return undefined;
}

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;

async function main(): Promise<void> {
  // --fresh: 書き換えの保存を使わず、書き換え直す / --candidates N, --chars C: select の候補の数と、本文の長さ
  useCache = !process.argv.includes("--fresh");
  const intFlag = (name: string, fallback: number): number => {
    const i = process.argv.indexOf(name);
    if (i === -1) return fallback;
    const value = Number(process.argv[i + 1]);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} には、1以上の整数を指定してください`);
    }
    return value;
  };
  selectConfig.candidates = intFlag("--candidates", selectConfig.candidates);
  selectConfig.chars = intFlag("--chars", selectConfig.chars);

  const methodName = process.argv.includes("--method")
    ? (process.argv[process.argv.indexOf("--method") + 1] ?? "")
    : "vector";
  const method = resolveMethod(methodName);
  if (!method) {
    throw new Error(
      `未知の方法です: ${methodName}(使えるのは vector / rewrite / rewrite+orig / fts / hybrid / select)`,
    );
  }

  // --show-top N: 各相談文の上位N件の段落 id も表示する(目で確認するため)
  const showTopIndex = process.argv.indexOf("--show-top");
  const showTop = showTopIndex === -1 ? 0 : Number(process.argv[showTopIndex + 1]);
  if (!Number.isInteger(showTop) || showTop < 0)
    throw new Error("--show-top には、整数を指定してください");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL が未設定です");
  console.log(`接続先: ${describeTarget(databaseUrl).label} / 方法: ${methodName}`);

  const raw: unknown = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "eval", "search-eval.json"), "utf-8"),
  );
  const evalFile = evalFileSchema.parse(raw);
  const unreviewed = evalFile.cases.filter((c) => c.reviewed === false).length;
  if (unreviewed > 0) {
    console.warn(`注意: ${unreviewed} 問は下書きで、人の確認が済んでいません(reviewed: false)`);
  }
  if (evalFile.status !== "reviewed") {
    console.warn("注意: 評価用の例題は、まだ人の確認が済んでいません(status が reviewed ではない)");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const outcomes = await method(
      evalFile.cases.map((c) => c.query),
      pool,
    );
    const ranks = evalFile.cases.map((c, i) => firstRank(outcomes[i]?.ids ?? [], c.expected));

    // --show-text: 上位3件の本文(冒頭 200字)も表示する。人が目で評価するため(例題の相談文だけが対象)
    const showText = process.argv.includes("--show-text");
    const textOf = async (id: string): Promise<string> => {
      const { rows } = await pool.query<{ verses: unknown }>(
        "SELECT verses FROM paragraphs WHERE id = $1",
        [id],
      );
      const verses = rows[0]?.verses;
      if (verses === undefined) return "(DB にない)";
      const text = buildContent({ verses: paragraphSchema.shape.verses.parse(verses) });
      return text.length > 200 ? `${text.slice(0, 200)}…` : text;
    };

    for (const [i, c] of evalFile.cases.entries()) {
      const rank = ranks[i];
      const shown = rank === undefined ? `>${MAX_RANK}位` : `${rank}位`;
      const mark = rank !== undefined && rank <= 3 ? "○" : "×";
      console.log(`${mark} ${c.id}  ${shown.padStart(7)}  ${c.query}`);
      if (showTop > 0) {
        console.log(
          `            上位${showTop}件: ${(outcomes[i]?.ids ?? []).slice(0, showTop).join(", ")}`,
        );
      }
      const note = outcomes[i]?.note;
      if (note) console.log(`            ${note}`);
      if (showText) {
        for (const id of (outcomes[i]?.ids ?? []).slice(0, 3)) {
          console.log(`            ▶ ${id}  ${await textOf(id)}`);
        }
        console.log("");
      }
    }

    const printSummary = (label: string, selected: (number | undefined)[]): void => {
      const s = summarize(selected);
      console.log(
        `${label} ${s.count}問: 1位 ${pct(s.hitAt1)} / 上位3件 ${pct(s.hitAt3)} / 上位10件 ${pct(s.hitAt10)} / 15件 ${pct(s.hitAt15)} / 20件 ${pct(s.hitAt20)} / 30件 ${pct(s.hitAt30)} / 平均逆順位 ${s.mrr.toFixed(3)}`,
      );
    };
    console.log("");
    for (const split of ["dev", "holdout"] as const) {
      const selected = ranks.filter((_, i) => evalFile.cases[i]?.split === split);
      if (selected.length > 0)
        printSummary(
          split === "dev" ? "【開発用(調整に使った)】" : "【確認用(調整に使っていない)】",
          selected,
        );
    }
    const summary = summarize(ranks);
    console.log(
      `\n${summary.count}問: 1位 ${pct(summary.hitAt1)} / 上位3件 ${pct(summary.hitAt3)} / 上位10件 ${pct(summary.hitAt10)} / 15件 ${pct(summary.hitAt15)} / 20件 ${pct(summary.hitAt20)} / 30件 ${pct(summary.hitAt30)} / 平均逆順位 ${summary.mrr.toFixed(3)}`,
    );
    if (usageTotal.promptTokens + usageTotal.completionTokens > 0) {
      // 生成モデルの単価(入力 $1.5 / 出力 $7.5 per 1M tokens)での、書き換えの費用の見積もり
      const dollars =
        (usageTotal.promptTokens * 1.5 + usageTotal.completionTokens * 7.5) / 1_000_000;
      console.log(
        `書き換えのトークン: 入力 ${usageTotal.promptTokens} / 出力 ${usageTotal.completionTokens}(約 $${dollars.toFixed(4)}、1問あたり約 $${(dollars / summary.count).toFixed(5)})`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "不明なエラー");
  process.exit(1);
});
