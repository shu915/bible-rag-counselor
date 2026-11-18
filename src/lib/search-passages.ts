// 悩みの相談文から、聖書の段落を3件取り出す(本番の検索)。
// 書き換え(現代語 → 口語訳の言い回し)→ ベクトル検索 + 全文検索を RRF で統合 → 候補 15件
// → LLM が3件を選ぶ → 足りなければ、候補の上から補う。
// - 「出さない箇所」は、候補を取る**前**に、検索の条件で外す(取ったあとで外すと、件数が減るため)
// - 聖句は、LLM に書かせない。選ばれた id を、DB から取り直して返す
// - 相談1件ぶんの全体の締め切り(signal)を、OpenRouter の呼び出しにも、やり直しの待ちにも渡す
// ユーザーの入力は繊細なので、入力も、書き換えた文も、選ばれた結果も、ログにも例外にも出さない。
import { createHash } from "node:crypto";
import { z } from "zod";
import { EXCLUDED_PASSAGE_IDS, GENERIC_PASSAGE_IDS } from "./excluded-passages";
import { buildTsQuery } from "./fts-query";
import { embedTexts } from "./openrouter";
import { pickDistinct } from "./passage-overlap";
import type { Verse } from "./quote";
import { rewriteQuery } from "./rewrite-query";
import { rrfFuse } from "./rrf";
import { fillSelection, selectPassages } from "./select-passages";
import { tokenizeQuery } from "./tokenizer";

// DB への問い合わせに必要な最小の形(pg の Pool を包んで渡す。テストでは、偽物を渡す)
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

// 1つのリストに取る件数(順位つきの段落 id)
const LIST_SIZE = 100;
// 選ぶ件数
const SELECT_COUNT = 3;

export interface FoundPassage {
  id: string;
  // 「書名 章:節」の表示用(例: マタイによる福音書 6:25-34)
  reference: string;
  // 本文(節をつないだもの)
  text: string;
  // 節ごとの本文(DB のまま)。引用する節の範囲を選ぶ・核心の節を太字にするために使う
  verses: Verse[];
}

// 検索の内訳(開発用。debug を指定したときだけ返す)。入力に近い内容(書き換えた文)を含むので、
// 画面やログには出さない。端末に、開発者が見るためだけに使う
export interface CandidateDebug {
  id: string;
  // RRF で統合した順位(1 から)
  rrfRank: number;
  // 書き換えた検索文ごとのベクトル検索・全文検索の順位のうち、いちばん良いもの(100 位までに入らなければ undefined)
  vectorRank?: number;
  ftsRank?: number;
  // 書き換えた検索文のベクトルとの、コサイン類似度(1 - コサイン距離)のうち、いちばん高いもの
  cosine?: number;
  // DB の本文の文字数
  chars: number;
  pickedByLlm: boolean;
  skippedAsDuplicate: boolean;
  adopted: boolean;
}

// 採用した段落が、DB から出た本物であることの証拠。LLM が知らない、DB だけが持つ値
// (id は、聖書の番号なので、LLM にも書ける。証拠にならない)
export interface DbProof {
  id: string;
  // DB の中の、行の物理的な位置(例 "(123,4)")。再投入すると変わる
  ctid: string;
  // ベクトルの先頭 3 次元(1,536 個のうちの、実際の値)
  embeddingHead: number[];
  // DB に保存されている本文の MD5(DB の側で計算)
  dbMd5: string;
  // 画面に出す本文の MD5(コードの側で計算)。dbMd5 と同じなら、本文は、DB のままで、1字も変わっていない
  shownMd5: string;
  matches: boolean;
}

export interface SearchDebug {
  rewrites: string[];
  candidates: CandidateDebug[];
  proofs: DbProof[];
}

export interface SearchResult {
  // 役割の順ではなく、LLM が選んだ順(足りなければ、候補の上から補った分が後ろに付く)
  passages: FoundPassage[];
  // 費用の見積もり用(本文は含まない)
  usage: { promptTokens: number; completionTokens: number };
  // debug を指定したときだけ
  debug?: SearchDebug;
}

export interface SearchOptions {
  // 常に外す段落(EXCLUDED_PASSAGE_IDS)に、この相談だけ、さらに外す段落を足す(例: 他人を傷つけたい入力のとき)
  excludeIds?: readonly string[];
  // 検索の内訳(順位・コサイン類似度など)も返す(開発用)
  debug?: boolean;
  // LLM に見せる候補の数(既定 15。人の目の比較で、20 より良く、10〜15 は同じくらい)
  candidates?: number;
  // 候補1件あたりの本文の長さ(既定 150字)
  maxCharsPerCandidate?: number;
  // 相談1件ぶんの全体の締め切り
  signal?: AbortSignal;
}

// 検索で、使える候補が1件も取れなかった。メッセージに、入力の中身を入れない
export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

const idRowsSchema = z.array(z.object({ id: z.string() }));
const passageRowsSchema = z.array(
  z.object({
    id: z.string(),
    book_name: z.string(),
    chapter: z.number(),
    verse_start: z.number(),
    verse_end: z.number(),
    verses: z.array(z.object({ verse: z.number(), verse_end: z.number(), text: z.string() })),
  }),
);

// 上位の候補を、count 件まで取る。ただし、**汎用的な段落(GENERIC_PASSAGE_IDS)は、上位 3 位に入っているときだけ残す**
// (その相談に、本当に合っているとき)。4 位以下の汎用的な段落は、候補の「かさ増し」なので、外す
export function pickCandidates(ranked: readonly string[], count: number): string[] {
  const generic = new Set(GENERIC_PASSAGE_IDS);
  const picked: string[] = [];
  for (const [index, id] of ranked.entries()) {
    if (picked.length >= count) break;
    if (generic.has(id) && index >= 3) continue;
    picked.push(id);
  }
  return picked;
}

// ベクトルに近い順の、段落 id(除外した箇所を除く)
async function vectorRank(
  db: Queryable,
  vector: number[],
  excluded: readonly string[],
): Promise<string[]> {
  const { rows } = await db.query(
    "SELECT id FROM paragraphs WHERE id <> ALL($2::text[]) ORDER BY embedding <=> $1::vector LIMIT $3",
    [`[${vector.join(",")}]`, [...excluded], LIST_SIZE],
  );
  return idRowsSchema.parse(rows).map((row) => row.id);
}

// 全文検索(分かち書きしたトークンの OR)で、順位つきの段落 id(除外した箇所を除く)。使えるトークンがなければ空
async function ftsRank(
  db: Queryable,
  text: string,
  excluded: readonly string[],
): Promise<string[]> {
  const query = buildTsQuery(await tokenizeQuery(text));
  if (!query) return [];
  const { rows } = await db.query(
    "SELECT id FROM paragraphs WHERE search_tsv @@ to_tsquery('simple', $1) AND id <> ALL($2::text[]) ORDER BY ts_rank(search_tsv, to_tsquery('simple', $1), 1) DESC, id LIMIT $3",
    [query, [...excluded], LIST_SIZE],
  );
  return idRowsSchema.parse(rows).map((row) => row.id);
}

const cosineRowsSchema = z.array(z.object({ id: z.string(), cosine: z.coerce.number() }));

// 検索文のベクトルと、指定した段落の、コサイン類似度(1 - コサイン距離)。開発用の内訳で使う
async function cosineOf(
  db: Queryable,
  vector: number[],
  ids: readonly string[],
): Promise<Map<string, number>> {
  const { rows } = await db.query(
    "SELECT id, 1 - (embedding <=> $1::vector) AS cosine FROM paragraphs WHERE id = ANY($2::text[])",
    [`[${vector.join(",")}]`, [...ids]],
  );
  return new Map(cosineRowsSchema.parse(rows).map((row) => [row.id, row.cosine]));
}

const proofRowsSchema = z.array(
  z.object({
    id: z.string(),
    ctid: z.string(),
    md5: z.string(),
    head: z.array(z.coerce.number()),
  }),
);

// 採用した段落の、DB だけが持つ値(ctid・ベクトルの先頭・本文の MD5)を、DB の側で計算して取る。
// 画面に出す本文の MD5 と、突き合わせる(開発用の内訳で、本文が DB のままであることを示す)
async function dbProofs(db: Queryable, passages: readonly FoundPassage[]): Promise<DbProof[]> {
  const { rows } = await db.query(
    `SELECT p.id, p.ctid::text AS ctid, md5(t.txt) AS md5, (p.embedding::real[])[1:3] AS head
     FROM paragraphs p,
     LATERAL (
       SELECT string_agg(e.v->>'text', '' ORDER BY e.ord) AS txt
       FROM jsonb_array_elements(p.verses) WITH ORDINALITY AS e(v, ord)
     ) t
     WHERE p.id = ANY($1::text[])`,
    [passages.map((p) => p.id)],
  );
  const byId = new Map(proofRowsSchema.parse(rows).map((row) => [row.id, row]));
  return passages.flatMap((p) => {
    const row = byId.get(p.id);
    if (!row) return [];
    const shownMd5 = createHash("md5").update(p.text).digest("hex");
    return [
      {
        id: p.id,
        ctid: row.ctid,
        embeddingHead: row.head,
        dbMd5: row.md5,
        shownMd5,
        matches: row.md5 === shownMd5,
      },
    ];
  });
}

// 段落 id から、表示用の情報と本文を取る。返す順番は、ids の順(DB にない id は、飛ばす)
async function loadPassages(db: Queryable, ids: readonly string[]): Promise<FoundPassage[]> {
  const { rows } = await db.query(
    "SELECT id, book_name, chapter, verse_start, verse_end, verses FROM paragraphs WHERE id = ANY($1::text[])",
    [[...ids]],
  );
  const byId = new Map(
    passageRowsSchema.parse(rows).map((row) => {
      const range =
        row.verse_start === row.verse_end
          ? `${row.verse_start}`
          : `${row.verse_start}-${row.verse_end}`;
      const passage: FoundPassage = {
        id: row.id,
        reference: `${row.book_name} ${row.chapter}:${range}`,
        text: row.verses.map((verse) => verse.text).join(""),
        verses: row.verses,
      };
      return [row.id, passage] as const;
    }),
  );
  return ids.flatMap((id) => {
    const passage = byId.get(id);
    return passage ? [passage] : [];
  });
}

// 相談文から、聖書の段落を3件取り出す
export async function searchPassages(
  db: Queryable,
  consultation: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const signal = options.signal;
  const requestOptions = signal ? { signal } : {};
  const usage = { promptTokens: 0, completionTokens: 0 };
  const addUsage = (u: { promptTokens?: number; completionTokens?: number }): void => {
    usage.promptTokens += u.promptTokens ?? 0;
    usage.completionTokens += u.completionTokens ?? 0;
  };

  // 外す段落: 常に外すもの + この相談だけ外すもの(重複は1つに)
  const excluded = [...new Set([...EXCLUDED_PASSAGE_IDS, ...(options.excludeIds ?? [])])];

  // 1. 書き換え(現代語 → 口語訳の言い回し)
  const rewritten = await rewriteQuery(consultation, requestOptions);
  addUsage(rewritten.usage);

  // 2. 書き換えた文それぞれで、ベクトル検索と全文検索 → RRF で統合 → 上位の候補
  const vectors = await embedTexts(rewritten.queries, requestOptions);
  const lists = await Promise.all([
    ...vectors.map((vector) => vectorRank(db, vector, excluded)),
    ...rewritten.queries.map((text) => ftsRank(db, text, excluded)),
  ]);
  const vectorLists = lists.slice(0, vectors.length);
  const ftsLists = lists.slice(vectors.length);
  const candidateIds = pickCandidates(rrfFuse(lists), options.candidates ?? 15);

  // 3. 候補の本文を取る(DB にない id は、飛ばす)
  const candidates = await loadPassages(db, candidateIds);
  if (candidates.length === 0) throw new SearchError("候補が見つかりませんでした");

  // 4. LLM が3件を選ぶ。足りなければ、候補の上から補う(0件の画面にしない)
  const selected = await selectPassages(
    consultation,
    candidates.map((c) => ({ id: c.id, text: c.text })),
    {
      count: SELECT_COUNT,
      ...(options.maxCharsPerCandidate === undefined
        ? {}
        : { maxCharsPerCandidate: options.maxCharsPerCandidate }),
      ...requestOptions,
    },
  );
  addUsage(selected.usage);
  // LLM が選んだ順 → 残りの候補(関連性の高い順)に並べて、並行記事のような重複を飛ばしながら、3件を選ぶ。
  // (補いは、この並びの後ろから。同じ教えの段落が、2つ入らないようにする)
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ordered = fillSelection(
    selected.ids,
    candidates.map((c) => c.id),
    candidates.length,
  ).flatMap((id) => {
    const passage = byId.get(id);
    return passage ? [passage] : [];
  });
  const distinct = pickDistinct(ordered, SELECT_COUNT);
  // 重複を除くと足りないときは、重複を許して、ある分で埋める(0件・少なすぎる画面にしない)
  const passages =
    distinct.length >= SELECT_COUNT
      ? distinct
      : [...distinct, ...ordered.filter((p) => !distinct.includes(p))].slice(0, SELECT_COUNT);
  if (!options.debug) return { passages, usage };

  // 開発用の内訳: 候補ごとの順位・コサイン類似度・どう扱われたか
  const cosines = await Promise.all(vectors.map((vector) => cosineOf(db, vector, candidateIds)));
  const bestRank = (listsOfIds: string[][], id: string): number | undefined => {
    const ranks = listsOfIds.map((list) => list.indexOf(id)).filter((i) => i !== -1);
    return ranks.length === 0 ? undefined : Math.min(...ranks) + 1;
  };
  const lastAdopted = Math.max(...passages.map((p) => ordered.indexOf(p)));
  const debug: SearchDebug = {
    proofs: await dbProofs(db, passages),
    rewrites: rewritten.queries,
    candidates: candidates.map((c, i) => {
      const cos = cosines.flatMap((m) => (m.has(c.id) ? [m.get(c.id) ?? 0] : []));
      const adopted = passages.includes(c);
      return {
        id: c.id,
        rrfRank: i + 1,
        vectorRank: bestRank(vectorLists, c.id),
        ftsRank: bestRank(ftsLists, c.id),
        cosine: cos.length === 0 ? undefined : Math.max(...cos),
        chars: c.text.length,
        pickedByLlm: selected.ids.includes(c.id),
        // 並びの中で、採用したものより前にあるのに、採用しなかった = 重複で飛ばした
        skippedAsDuplicate:
          !adopted && ordered.indexOf(c) !== -1 && ordered.indexOf(c) < lastAdopted,
        adopted,
      };
    }),
  };
  return { passages, usage, debug };
}
