import { beforeEach, describe, expect, it, vi } from "vitest";

// 本物の AI・DB は使わない(検索と生成を差し替える)。危機の検出は、本物を使う
const mocks = vi.hoisted(() => ({ searchPassages: vi.fn(), generateCounsel: vi.fn() }));
vi.mock("./search-passages", () => ({ searchPassages: mocks.searchPassages }));
vi.mock("./generate-counsel", () => ({ generateCounsel: mocks.generateCounsel }));

import { runCounsel } from "./counsel-api";
import { MAX_INPUT_CHARS, counselRequestSchema } from "./counsel-schema";
import type { Queryable } from "./search-passages";

const db: Queryable = { query: async () => ({ rows: [] }) };

const passage = {
  id: "Matt.6.19-24",
  reference: "マタイによる福音書 6:19-24",
  text: "一二三四",
  verses: [
    { verse: 19, verse_end: 19, text: "地上に宝をたくわえるな。" },
    { verse: 20, verse_end: 20, text: "天に宝をたくわえよ。" },
    { verse: 21, verse_end: 21, text: "宝のある所に心もある。" },
    { verse: 22, verse_end: 24, text: "目は体のあかり。" },
  ],
};

beforeEach(() => {
  mocks.searchPassages.mockReset();
  mocks.generateCounsel.mockReset();
  mocks.searchPassages.mockResolvedValue({
    passages: [passage],
    usage: { promptTokens: 1, completionTokens: 1 },
  });
  mocks.generateCounsel.mockResolvedValue({
    preface: "それは聖書には載っていませんが、富を失うことと受け止めました。",
    commentaries: [
      {
        id: "Matt.6.19-24",
        commentary: "宝のある所に心もある、という言葉です。",
        quote: { from: 19, to: 21 },
        core: { from: 21, to: 21 },
      },
    ],
    conclusion: "今日は早く休みましょう。",
    crisis: false,
    usage: {},
  });
});

describe("counselRequestSchema", () => {
  it("前後の空白を除く。空・長すぎる入力は断る", () => {
    expect(counselRequestSchema.parse({ consultation: "  疲れた  " }).consultation).toBe("疲れた");
    expect(counselRequestSchema.safeParse({ consultation: "   " }).success).toBe(false);
    expect(
      counselRequestSchema.safeParse({ consultation: "あ".repeat(MAX_INPUT_CHARS) }).success,
    ).toBe(true);
    expect(
      counselRequestSchema.safeParse({ consultation: "あ".repeat(MAX_INPUT_CHARS + 1) }).success,
    ).toBe(false);
    expect(counselRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("runCounsel", () => {
  it("引用の範囲と核心の節の印をつけて、解説と結論といっしょに返す(本文は DB の節のまま)", async () => {
    const result = await runCounsel(db, { consultation: "仮想通貨が暴落した" });
    if (result.kind !== "ok") throw new Error("ok のはず");
    expect(result.preface).toContain("聖書には載っていませんが");
    expect(result.conclusion).toBe("今日は早く休みましょう。");
    expect(result.showHelp).toBe(false);

    const [view] = result.passages;
    expect(view.reference).toBe("マタイによる福音書 6:19-24");
    expect(view.commentary).toBe("宝のある所に心もある、という言葉です。");
    expect(view.verses).toEqual([
      { label: "19", text: "地上に宝をたくわえるな。", inQuote: true, core: false },
      { label: "20", text: "天に宝をたくわえよ。", inQuote: true, core: false },
      { label: "21", text: "宝のある所に心もある。", inQuote: true, core: true },
      { label: "22-24", text: "目は体のあかり。", inQuote: false, core: false },
    ]);
  });

  it("解説が、画面に出ない節(範囲の外)の言葉を「」で引いた文は、落とす。出る節の言葉の文は、残す", async () => {
    mocks.generateCounsel.mockResolvedValueOnce({
      preface: null,
      commentaries: [
        {
          id: "Matt.6.19-24",
          commentary:
            "「天に宝をたくわえよ」という言葉です。「目は体のあかり」という言葉も、続きます。最後は静かです。",
          quote: { from: 19, to: 21 },
        },
      ],
      conclusion: "y",
      crisis: false,
      usage: {},
    });
    const result = await runCounsel(db, { consultation: "疲れた" });
    if (result.kind !== "ok") throw new Error("ok のはず");
    // 22-24 節(「目は体のあかり」)は、引用の範囲の外
    expect(result.passages[0].commentary).toBe(
      "「天に宝をたくわえよ」という言葉です。最後は静かです。",
    );
  });

  it("画面の箇所は、AI が決めた読む順(解説の順)に並べる", async () => {
    const other = { ...passage, id: "Ps.23.1-6", reference: "詩篇 23:1-6" };
    mocks.searchPassages.mockResolvedValueOnce({
      passages: [passage, other],
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    mocks.generateCounsel.mockResolvedValueOnce({
      preface: null,
      // 読む順は、詩篇 23 が先(検索の順は、マタイが先)
      commentaries: [
        { id: "Ps.23.1-6", commentary: "先" },
        { id: "Matt.6.19-24", commentary: "後" },
      ],
      conclusion: "y",
      crisis: false,
      usage: {},
    });
    const result = await runCounsel(db, { consultation: "疲れた" });
    if (result.kind !== "ok") throw new Error("ok のはず");
    expect(result.passages.map((p) => p.reference)).toEqual([
      "詩篇 23:1-6",
      "マタイによる福音書 6:19-24",
    ]);
  });

  it("AI の文章が異常に長くても、画面に出す長さに上限をかける", async () => {
    mocks.generateCounsel.mockResolvedValueOnce({
      preface: "あ".repeat(5_000),
      commentaries: [{ id: "Matt.6.19-24", commentary: "い".repeat(5_000) }],
      conclusion: "う".repeat(5_000),
      crisis: false,
      usage: {},
    });
    const result = await runCounsel(db, { consultation: "疲れた" });
    if (result.kind !== "ok") throw new Error("ok のはず");
    expect(result.preface?.length).toBeLessThanOrEqual(401);
    expect(result.passages[0].commentary.length).toBeLessThanOrEqual(1_201);
    expect(result.conclusion.length).toBeLessThanOrEqual(1_501);
  });

  it("命の危険を示す語は、AI も検索も呼ばずに、固定の画面にする", async () => {
    expect(await runCounsel(db, { consultation: "もう死にたい" })).toEqual({ kind: "crisis" });
    expect(mocks.searchPassages).not.toHaveBeenCalled();
    expect(mocks.generateCounsel).not.toHaveBeenCalled();
  });

  it("「それでも続ける」なら、続けて答える。相談窓口の案内(showHelp)を添える", async () => {
    const result = await runCounsel(db, {
      consultation: "死にたいくらい恥ずかしい",
      continueAnyway: true,
    });
    expect(result).toMatchObject({ kind: "ok", showHelp: true });
    expect(mocks.generateCounsel).toHaveBeenCalledTimes(1);
  });

  it("「それでも続ける」のときだけ、生成に、危機の文脈(crisisContext)を渡す", async () => {
    await runCounsel(db, { consultation: "死にたいくらい恥ずかしい", continueAnyway: true });
    expect(mocks.generateCounsel.mock.calls[0][2]).toMatchObject({ crisisContext: true });

    mocks.generateCounsel.mockClear();
    await runCounsel(db, { consultation: "仕事で疲れた" });
    expect(mocks.generateCounsel.mock.calls[0][2]).toMatchObject({ crisisContext: false });
  });

  it("他人を傷つけたい気持ちを示す語があるときは、画面は止めず(AI を呼ぶ)、harmContext を渡す", async () => {
    const result = await runCounsel(db, { consultation: "あいつぶっ殺してやる" });
    expect(result.kind).toBe("ok");
    expect(mocks.generateCounsel.mock.calls[0][2]).toMatchObject({
      harmContext: true,
      crisisContext: false,
    });

    mocks.generateCounsel.mockClear();
    await runCounsel(db, { consultation: "仕事で疲れた" });
    expect(mocks.generateCounsel.mock.calls[0][2]).toMatchObject({ harmContext: false });
  });

  it("他人を傷つけたい気持ちのときだけ、相談者を責めるように読める箇所を、検索から外す", async () => {
    await runCounsel(db, { consultation: "あいつぶっ殺してやる" });
    expect(mocks.searchPassages.mock.calls[0][2]).toMatchObject({
      excludeIds: expect.arrayContaining(["1John.3.13-24", "Matt.5.21-26", "Jas.4.1-10"]),
    });

    mocks.searchPassages.mockClear();
    await runCounsel(db, { consultation: "仕事で疲れた" });
    expect(mocks.searchPassages.mock.calls[0][2]).not.toHaveProperty("excludeIds");
  });

  it("命の危険を示す語があって「それでも続ける」のとき、命が失われることを語る節を、引用から外す", async () => {
    const withLoss = {
      ...passage,
      verses: [
        { verse: 19, verse_end: 19, text: "彼らは滅ぼされ、一掃された。" },
        { verse: 20, verse_end: 20, text: "夢みた人の目をさました時のようである。" },
        { verse: 21, verse_end: 21, text: "わたしの魂が痛み、心が刺された。" },
      ],
    };
    mocks.searchPassages.mockResolvedValue({ passages: [withLoss], usage: {} });
    mocks.generateCounsel.mockResolvedValue({
      preface: null,
      commentaries: [
        {
          id: "Matt.6.19-24",
          commentary: "x",
          quote: { from: 19, to: 21 },
          core: { from: 21, to: 21 },
        },
      ],
      conclusion: "y",
      crisis: false,
      usage: {},
    });

    const crisis = await runCounsel(db, { consultation: "消えたい", continueAnyway: true });
    if (crisis.kind !== "ok") throw new Error("ok のはず");
    // 19 節(滅び・一掃)は、引用に入らない
    expect(crisis.passages[0].verses.filter((v) => v.inQuote).map((v) => v.label)).toEqual([
      "20",
      "21",
    ]);

    // ふつうの相談では、外さない
    const normal = await runCounsel(db, { consultation: "仕事で疲れた" });
    if (normal.kind !== "ok") throw new Error("ok のはず");
    expect(normal.passages[0].verses.filter((v) => v.inQuote)).toHaveLength(3);
  });

  it("AI が、命に関わる内容だと判断したら、解説を出さず、固定の画面にする(補助の防御)", async () => {
    mocks.generateCounsel.mockResolvedValueOnce({
      preface: null,
      commentaries: [{ id: "Matt.6.19-24", commentary: "x" }],
      conclusion: "y",
      crisis: true,
      usage: {},
    });
    expect(await runCounsel(db, { consultation: "もう限界で、何も考えられない" })).toEqual({
      kind: "crisis",
    });
  });

  it("全体の締め切り(signal)を、検索と生成に渡す", async () => {
    const controller = new AbortController();
    await runCounsel(db, { consultation: "疲れた" }, controller.signal);
    expect(mocks.searchPassages.mock.calls[0][2]).toEqual({ signal: controller.signal });
    expect(mocks.generateCounsel.mock.calls[0][2]).toMatchObject({ signal: controller.signal });
  });

  it("AI が範囲を返さなかったときは、段落の先頭から、短く切った範囲を引用にする", async () => {
    mocks.generateCounsel.mockResolvedValueOnce({
      preface: null,
      commentaries: [{ id: "Matt.6.19-24", commentary: "x" }],
      conclusion: "y",
      crisis: false,
      usage: {},
    });
    const result = await runCounsel(db, { consultation: "疲れた" });
    if (result.kind !== "ok") throw new Error("ok のはず");
    // 短い段落なので、全部が引用になる。核心の印はない
    expect(result.passages[0].verses.every((v) => v.inQuote)).toBe(true);
    expect(result.passages[0].verses.some((v) => v.core)).toBe(false);
  });
});
