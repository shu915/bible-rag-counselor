import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 本物の OpenRouter・辞書は使わない(書き換え・ベクトル化・選択・分かち書きを差し替える)
const mocks = vi.hoisted(() => ({
  rewriteQuery: vi.fn(),
  embedTexts: vi.fn(),
  selectPassages: vi.fn(),
}));
vi.mock("./rewrite-query", () => ({ rewriteQuery: mocks.rewriteQuery }));
vi.mock("./openrouter", () => ({ embedTexts: mocks.embedTexts }));
vi.mock("./tokenizer", () => ({
  MAX_QUERY_CHARS: 2000,
  tokenizeQuery: async (text: string) => text.split(/\s+/).filter((t) => t !== ""),
}));
vi.mock("./select-passages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./select-passages")>()),
  selectPassages: mocks.selectPassages,
}));

import { EXCLUDED_PASSAGE_IDS } from "./excluded-passages";
import { pickCandidates, searchPassages, SearchError, type Queryable } from "./search-passages";

const row = (id: string, book = "テスト書", chapter = 1, start = 1, end = 3) => ({
  id,
  book_name: book,
  chapter,
  verse_start: start,
  verse_end: end,
  verses: [
    { verse: start, verse_end: start, text: `${id}の` },
    { verse: end, verse_end: end, text: "本文" },
  ],
});

// 偽の DB。ベクトル検索・全文検索・本文の取得を、SQL の文面で見分けて、決まった答えを返す
function fakeDb(options: {
  vectorIds: string[];
  ftsIds: string[];
  rows: ReturnType<typeof row>[];
  // DB の本文が、表示した本文と食い違っている状況を作る(MD5 をわざと変える)
  corruptMd5Ids?: string[];
}): { db: Queryable; calls: { text: string; values: unknown[] }[] } {
  const calls: { text: string; values: unknown[] }[] = [];
  const db: Queryable = {
    async query(text, values = []) {
      calls.push({ text, values });
      // DB だけが持つ値(ctid・ベクトルの先頭・本文の MD5)の問い合わせ(開発用の内訳)
      if (text.includes("md5(")) {
        const ids = values[0] as string[];
        return {
          rows: ids.map((id) => ({
            id,
            ctid: "(0,1)",
            md5: createHash("md5")
              .update(options.corruptMd5Ids?.includes(id) ? "違う本文" : `${id}の本文`)
              .digest("hex"),
            head: [0.1, 0.2, 0.3],
          })),
        };
      }
      // コサイン類似度の問い合わせ(開発用の内訳)
      if (text.includes("AS cosine")) {
        const ids = values[1] as string[];
        return { rows: ids.map((id, i) => ({ id, cosine: 0.9 - i * 0.01 })) };
      }
      if (text.includes("embedding <=>")) return { rows: options.vectorIds.map((id) => ({ id })) };
      if (text.includes("to_tsquery")) return { rows: options.ftsIds.map((id) => ({ id })) };
      return { rows: options.rows };
    },
  };
  return { db, calls };
}

const vec = [0.1, 0.2];

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.rewriteQuery.mockResolvedValue({
    queries: ["思いわずらう", "休ませる"],
    usage: { promptTokens: 100, completionTokens: 20 },
  });
  mocks.embedTexts.mockResolvedValue([vec, vec]);
});

describe("searchPassages", () => {
  it("書き換え → 検索 → 選択の順に進み、選ばれた3件の表示用の情報と本文を返す", async () => {
    const rows = ["A.1.1-3", "B.2.1-3", "C.3.1-3", "D.4.1-3"].map((id) => row(id));
    const { db } = fakeDb({
      vectorIds: ["A.1.1-3", "B.2.1-3"],
      ftsIds: ["C.3.1-3", "D.4.1-3"],
      rows,
    });
    mocks.selectPassages.mockResolvedValue({
      ids: ["C.3.1-3", "A.1.1-3", "D.4.1-3"],
      usage: { promptTokens: 900, completionTokens: 50 },
    });

    const result = await searchPassages(db, "疲れた");
    expect(result.passages.map((p) => p.id)).toEqual(["C.3.1-3", "A.1.1-3", "D.4.1-3"]);
    expect(result.passages[0]).toEqual({
      id: "C.3.1-3",
      reference: "テスト書 1:1-3",
      text: "C.3.1-3の本文",
      // 節ごとの本文(DB のまま)。引用する節の範囲を選ぶ・核心の節を太字にするために使う
      verses: [
        { verse: 1, verse_end: 1, text: "C.3.1-3の" },
        { verse: 3, verse_end: 3, text: "本文" },
      ],
    });
    expect(result.usage).toEqual({ promptTokens: 1000, completionTokens: 70 });
  });

  it("「出さない箇所」を、検索の条件に渡す(取ったあとで外さない)", async () => {
    const { db, calls } = fakeDb({
      vectorIds: ["A.1.1-3"],
      ftsIds: ["A.1.1-3"],
      rows: [row("A.1.1-3")],
    });
    mocks.selectPassages.mockResolvedValue({ ids: ["A.1.1-3"], usage: {} });

    await searchPassages(db, "疲れた");
    const searches = calls.filter(
      (c) => c.text.includes("embedding <=>") || c.text.includes("to_tsquery"),
    );
    expect(searches.length).toBeGreaterThan(0);
    for (const search of searches) {
      expect(search.text).toContain("<> ALL");
      expect(search.values).toContainEqual([...EXCLUDED_PASSAGE_IDS]);
    }
  });

  it("並行記事のように、同じ言い回しを共有する2件は、後ろのほうを飛ばして、次の候補を選ぶ", async () => {
    const shared = "なぜ兄弟の目にあるちりを見ながら自分の目にある梁を認めないのか";
    const rows = [
      {
        ...row("Matt.7.1-5"),
        verses: [{ verse: 1, verse_end: 1, text: `人をさばくな。${shared}。` }],
      },
      {
        ...row("Luke.6.39-45"),
        verses: [{ verse: 1, verse_end: 1, text: `盲人の手引。${shared}。悪い実。` }],
      },
      row("Ps.51.1-19"),
      row("Gal.6.1-5"),
    ];
    const { db } = fakeDb({
      vectorIds: ["Matt.7.1-5", "Luke.6.39-45", "Ps.51.1-19", "Gal.6.1-5"],
      ftsIds: [],
      rows,
    });
    mocks.selectPassages.mockResolvedValue({
      ids: ["Matt.7.1-5", "Luke.6.39-45", "Ps.51.1-19"],
      usage: {},
    });

    const result = await searchPassages(db, "疲れた");
    expect(result.passages.map((p) => p.id)).toEqual(["Matt.7.1-5", "Ps.51.1-19", "Gal.6.1-5"]);
  });

  it("debug を指定したときだけ、候補ごとの順位・コサイン類似度・扱いを返す", async () => {
    const rows = ["A.1.1-3", "B.2.1-3", "C.3.1-3"].map((id) => row(id));
    const { db } = fakeDb({
      vectorIds: ["A.1.1-3", "B.2.1-3", "C.3.1-3"],
      ftsIds: ["C.3.1-3"],
      rows,
    });
    mocks.selectPassages.mockResolvedValue({ ids: ["C.3.1-3", "A.1.1-3"], usage: {} });

    const plain = await searchPassages(db, "疲れた");
    expect(plain.debug).toBeUndefined();

    const result = await searchPassages(db, "疲れた", { debug: true });
    expect(result.debug?.rewrites).toEqual(["思いわずらう", "休ませる"]);
    const byId = new Map(result.debug?.candidates.map((c) => [c.id, c]));
    const c = byId.get("C.3.1-3");
    expect(c).toMatchObject({ pickedByLlm: true, adopted: true, ftsRank: 1, vectorRank: 3 });
    expect(c?.cosine).toBeGreaterThan(0.8);
    expect(c?.chars).toBe("C.3.1-3の本文".length);
    // 補いで採用された段落は、LLM が選んだものではない
    expect(byId.get("B.2.1-3")).toMatchObject({ pickedByLlm: false, adopted: true });
  });

  it("debug では、採用した段落の、DB だけが持つ値と、本文の MD5 の一致を返す", async () => {
    const rows = ["A.1.1-3", "B.2.1-3", "C.3.1-3"].map((id) => row(id));
    const { db } = fakeDb({
      vectorIds: ["A.1.1-3", "B.2.1-3", "C.3.1-3"],
      ftsIds: [],
      rows,
    });
    mocks.selectPassages.mockResolvedValue({ ids: ["A.1.1-3", "B.2.1-3", "C.3.1-3"], usage: {} });

    const result = await searchPassages(db, "疲れた", { debug: true });
    expect(result.debug?.proofs).toHaveLength(3);
    for (const proof of result.debug?.proofs ?? []) {
      expect(proof.ctid).toBe("(0,1)");
      expect(proof.embeddingHead).toEqual([0.1, 0.2, 0.3]);
      expect(proof.matches).toBe(true);
      expect(proof.shownMd5).toBe(proof.dbMd5);
    }
  });

  it("画面に出す本文が、DB の本文と1字でも違えば、MD5 が一致しない(AI が書き直した場合など)", async () => {
    const rows = ["A.1.1-3", "B.2.1-3", "C.3.1-3"].map((id) => row(id));
    const { db } = fakeDb({
      vectorIds: ["A.1.1-3", "B.2.1-3", "C.3.1-3"],
      ftsIds: [],
      rows,
      corruptMd5Ids: ["B.2.1-3"],
    });
    mocks.selectPassages.mockResolvedValue({ ids: ["A.1.1-3", "B.2.1-3", "C.3.1-3"], usage: {} });

    const result = await searchPassages(db, "疲れた", { debug: true });
    const matches = new Map(result.debug?.proofs.map((p) => [p.id, p.matches]));
    expect(matches.get("A.1.1-3")).toBe(true);
    expect(matches.get("B.2.1-3")).toBe(false);
  });

  it("excludeIds を渡すと、常に外す段落に足して、検索の条件に渡す(重複は1つ)", async () => {
    const { db, calls } = fakeDb({
      vectorIds: ["A.1.1-3"],
      ftsIds: ["A.1.1-3"],
      rows: [row("A.1.1-3")],
    });
    mocks.selectPassages.mockResolvedValue({ ids: ["A.1.1-3"], usage: {} });

    await searchPassages(db, "疲れた", { excludeIds: ["1John.3.13-24", EXCLUDED_PASSAGE_IDS[0]] });
    const searches = calls.filter(
      (c) => c.text.includes("embedding <=>") || c.text.includes("to_tsquery"),
    );
    for (const search of searches) {
      const excluded = search.values.find((v) => Array.isArray(v)) as string[];
      expect(excluded).toContain("1John.3.13-24");
      expect(excluded).toContain(EXCLUDED_PASSAGE_IDS[0]);
      expect(new Set(excluded).size).toBe(excluded.length);
    }
  });

  it("LLM が選んだ数が足りなければ、候補の上から補う", async () => {
    const rows = ["A.1.1-3", "B.2.1-3", "C.3.1-3"].map((id) => row(id));
    const { db } = fakeDb({ vectorIds: ["A.1.1-3", "B.2.1-3", "C.3.1-3"], ftsIds: [], rows });
    mocks.selectPassages.mockResolvedValue({ ids: ["C.3.1-3"], usage: {} });

    const result = await searchPassages(db, "疲れた");
    expect(result.passages.map((p) => p.id)).toEqual(["C.3.1-3", "A.1.1-3", "B.2.1-3"]);
  });

  it("選択の返答が崩れて、0件でも、候補の上から3件を返す", async () => {
    const rows = ["A.1.1-3", "B.2.1-3", "C.3.1-3", "D.4.1-3"].map((id) => row(id));
    const { db } = fakeDb({
      vectorIds: ["A.1.1-3", "B.2.1-3", "C.3.1-3", "D.4.1-3"],
      ftsIds: [],
      rows,
    });
    mocks.selectPassages.mockResolvedValue({ ids: [], usage: {} });

    const result = await searchPassages(db, "疲れた");
    expect(result.passages).toHaveLength(3);
  });

  it("候補が1件も取れなければ、SearchError(選択を呼ばない)", async () => {
    const { db } = fakeDb({ vectorIds: [], ftsIds: [], rows: [] });
    await expect(searchPassages(db, "疲れた")).rejects.toThrow(SearchError);
    expect(mocks.selectPassages).not.toHaveBeenCalled();
  });

  it("候補の数と、本文の長さと、全体の締め切りを、各段階に渡す", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `X.${i + 1}.1`);
    const { db } = fakeDb({ vectorIds: ids, ftsIds: [], rows: ids.map((id) => row(id)) });
    mocks.selectPassages.mockResolvedValue({ ids: ids.slice(0, 3), usage: {} });
    const controller = new AbortController();

    await searchPassages(db, "疲れた", {
      candidates: 10,
      maxCharsPerCandidate: 99,
      signal: controller.signal,
    });
    expect(mocks.rewriteQuery.mock.calls[0][1]).toEqual({ signal: controller.signal });
    expect(mocks.embedTexts.mock.calls[0][1]).toEqual({ signal: controller.signal });
    const [, candidates, selectOptions] = mocks.selectPassages.mock.calls[0];
    expect(candidates).toHaveLength(10);
    expect(selectOptions).toMatchObject({
      count: 3,
      maxCharsPerCandidate: 99,
      signal: controller.signal,
    });
  });

  it("エラーのメッセージに、入力の中身を入れない", async () => {
    const secret = "上司に言えない秘密の悩み";
    const { db } = fakeDb({ vectorIds: [], ftsIds: [], rows: [] });
    const error = await searchPassages(db, secret).catch((e: unknown) => e);
    expect(String(error)).not.toContain(secret);
  });
});

describe("pickCandidates(汎用的な段落は、上位 3 位のときだけ残す)", () => {
  const ranked = ["A", "B", "C", "Matt.11.28-30", "D", "Prov.3.21-35", "Eccl.4.6", "E", "F"];

  it("4 位以下の汎用的な段落は、外す。その分、次の候補が繰り上がる", () => {
    expect(pickCandidates(ranked, 5)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("上位 3 位に入っている汎用的な段落は、本当に合っているので、残す", () => {
    expect(pickCandidates(["Matt.11.28-30", "A", "B", "C", "D"], 4)).toEqual([
      "Matt.11.28-30",
      "A",
      "B",
      "C",
    ]);
    expect(pickCandidates(["A", "B", "Prov.3.21-35", "C"], 3)).toEqual(["A", "B", "Prov.3.21-35"]);
  });

  it("汎用的でない段落は、そのまま。件数の上限も守る。候補が足りなければ、ある分だけ", () => {
    expect(pickCandidates(["A", "B", "C", "D", "E"], 3)).toEqual(["A", "B", "C"]);
    // 汎用的な段落が 2 位なら、上位 3 位なので、残る
    expect(pickCandidates(["A", "Matt.11.28-30"], 5)).toEqual(["A", "Matt.11.28-30"]);
    // 5 位なら、外れる(候補が足りなくても、4位以下の汎用的な段落は、入れない)
    expect(pickCandidates(["A", "B", "C", "D", "Matt.11.28-30"], 10)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("EXCLUDED_PASSAGE_IDS", () => {
  it("人が判定した6件が入っている。伝道 4:6 のような、悩みで変わるものは入れない", () => {
    expect(EXCLUDED_PASSAGE_IDS).toEqual(
      expect.arrayContaining(["Isa.40.27-31", "1Pet.2.18-25", "Job.3.20-26", "Jas.1.5-8"]),
    );
    expect(EXCLUDED_PASSAGE_IDS).not.toContain("Eccl.4.6");
  });
});
