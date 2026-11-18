import { describe, expect, it } from "vitest";
import { buildQuote, isValidRange, type Verse } from "./quote";

const v = (verse: number, text: string, verse_end = verse): Verse => ({ verse, verse_end, text });
// 5節の段落(各節 10字)
const five: Verse[] = [1, 2, 3, 4, 5].map((n) => v(n, `${n}`.repeat(10)));

describe("isValidRange", () => {
  it("段落の節の範囲に収まる、整数の組なら true", () => {
    expect(isValidRange({ from: 2, to: 4 }, five)).toBe(true);
    expect(isValidRange({ from: 1, to: 5 }, five)).toBe(true);
  });

  it("範囲外・逆順・小数・欠けは false", () => {
    expect(isValidRange({ from: 0, to: 3 }, five)).toBe(false);
    expect(isValidRange({ from: 2, to: 9 }, five)).toBe(false);
    expect(isValidRange({ from: 4, to: 2 }, five)).toBe(false);
    expect(isValidRange({ from: 1.5, to: 3 }, five)).toBe(false);
    expect(isValidRange({ from: 2, to: undefined }, five)).toBe(false);
    expect(isValidRange({ from: null, to: null }, five)).toBe(false);
  });
});

describe("buildQuote", () => {
  it("正しい範囲なら、その節だけを、DB の節からつないで返す。段落の一部なので partial", () => {
    const quote = buildQuote(five, { from: 2, to: 3 });
    expect(quote).toMatchObject({
      from: 2,
      to: 3,
      text: `${"2".repeat(10)}${"3".repeat(10)}`,
      partial: true,
    });
    // 引用した節は、DB の節のまま、節ごとに持つ(画面で、核心の節を太字にするため)
    expect(quote.verses.map((verse) => verse.verse)).toEqual([2, 3]);
  });

  it("段落の全部を選んだら、partial ではない", () => {
    expect(buildQuote(five, { from: 1, to: 5 }).partial).toBe(false);
  });

  it("範囲が使えない・ないときは、先頭から、目安の長さを超えるまでの節", () => {
    const long: Verse[] = [1, 2, 3, 4, 5].map((n) => v(n, `${n}`.repeat(100)));
    const fallback = buildQuote(long, { from: 9, to: 9 });
    // 100字ずつ: 350字に届く 4節目まで
    expect(fallback.from).toBe(1);
    expect(fallback.to).toBe(4);
    expect(fallback.partial).toBe(true);
    expect(buildQuote(long)).toEqual(fallback);
  });

  it("短い段落なら、全部を返す(partial ではない)", () => {
    expect(buildQuote(five).partial).toBe(false);
  });

  it("選んだ範囲が長すぎたら、後ろの節から削る。1節は残す", () => {
    const long: Verse[] = [1, 2, 3].map((n) => v(n, `${n}`.repeat(400)));
    expect(buildQuote(long, { from: 1, to: 3 })).toMatchObject({ from: 1, to: 1 });
    const huge: Verse[] = [v(1, "あ".repeat(1000))];
    expect(buildQuote(huge, { from: 1, to: 1 }).text).toHaveLength(1000);
  });

  it("2節まとめの節は、その両方の番号を含む範囲として扱う", () => {
    const merged: Verse[] = [v(1, "一"), v(2, "二三", 3), v(4, "四")];
    expect(buildQuote(merged, { from: 3, to: 3 })).toMatchObject({ from: 2, to: 3, text: "二三" });
  });

  it("核心の節(core)は、引用した節の範囲に収まるときだけ残す", () => {
    expect(buildQuote(five, { from: 1, to: 4 }, { from: 2, to: 3 }).core).toEqual({
      from: 2,
      to: 3,
    });
    // 引用した範囲の外・型が違うものは、捨てる
    expect(buildQuote(five, { from: 1, to: 2 }, { from: 3, to: 4 }).core).toBeUndefined();
    expect(buildQuote(five, { from: 1, to: 2 }).core).toBeUndefined();
  });

  it("節が多すぎるときは、上限(8節)まで、核心の節を中心に削る(15節の引用を出さない)", () => {
    const many: Verse[] = Array.from({ length: 15 }, (_, i) => v(i + 1, "あ".repeat(10)));
    // 核心が 12 節: 前を削って、核心を残す
    const nearEnd = buildQuote(many, { from: 1, to: 15 }, { from: 12, to: 12 });
    expect(nearEnd.verses).toHaveLength(8);
    expect(nearEnd.verses.map((x) => x.verse)).toContain(12);
    expect(nearEnd.core).toEqual({ from: 12, to: 12 });
    // 核心が 2 節: 後ろを削って、核心を残す
    const nearStart = buildQuote(many, { from: 1, to: 15 }, { from: 2, to: 2 });
    expect(nearStart.verses.map((x) => x.verse)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 核心がなければ、後ろから削る(先頭の8節)
    expect(buildQuote(many, { from: 1, to: 15 }).verses).toHaveLength(8);
  });

  it("長さの上限(450字)を超えるときも、核心を残して削る。核心自体が長いときは、削らない", () => {
    const long: Verse[] = [1, 2, 3, 4].map((n) => v(n, `${n}`.repeat(200)));
    const quote = buildQuote(long, { from: 1, to: 4 }, { from: 3, to: 3 });
    expect(quote.verses.map((x) => x.verse)).toContain(3);
    expect(quote.text.length).toBeLessThanOrEqual(600);
    // 核心の1節が 1000字でも、その節は残る
    const huge: Verse[] = [v(1, "あ".repeat(100)), v(2, "い".repeat(1000)), v(3, "う".repeat(100))];
    expect(
      buildQuote(huge, { from: 1, to: 3 }, { from: 2, to: 2 }).verses.map((x) => x.verse),
    ).toEqual([2]);
  });

  it("avoid を指定すると、その言葉を含む節を外し、核心に近い、つながった範囲に絞る(命の危険の入力のとき)", () => {
    // 詩篇 73:16-22 の形: 18-19 節に「滅び」「一掃」がある
    const ps73: Verse[] = [
      v(16, "めんどうな仕事のように思われた。"),
      v(17, "神の聖所に行って、悟り得た。"),
      v(18, "彼らを滅びに陥らせられる。"),
      v(19, "またたくまに滅ぼされ、一掃された。"),
      v(20, "夢みた人の目をさました時のようである。"),
      v(21, "わたしの魂が痛み、心が刺された。"),
      v(22, "わたしは愚かで悟りがなかった。"),
    ];
    const avoid = /滅|一掃/;
    // 核心が 21 節: 20-22 節だけが残る(18-19 を越えて、16-17 には戻らない)
    const q = buildQuote(ps73, { from: 16, to: 22 }, { from: 21, to: 21 }, { avoid });
    expect(q.verses.map((x) => x.verse)).toEqual([20, 21, 22]);
    expect(q.core).toEqual({ from: 21, to: 21 });
    // 核心が 17 節: 16-17 節だけが残る
    expect(
      buildQuote(ps73, { from: 16, to: 22 }, { from: 17, to: 17 }, { avoid }).verses.map(
        (x) => x.verse,
      ),
    ).toEqual([16, 17]);
    // 核心の節が、その言葉を含むときは、最も近い、含まない節から(後ろの 20 節)
    const near = buildQuote(ps73, { from: 16, to: 22 }, { from: 19, to: 19 }, { avoid });
    expect(near.verses.map((x) => x.verse)).toEqual([20, 21, 22]);
  });

  it("avoid を指定しなければ、これまでどおり。含まない範囲・すべてが含む範囲は、そのまま", () => {
    const verses: Verse[] = [v(1, "滅びの話。"), v(2, "滅ぼされる話。")];
    expect(buildQuote(verses, { from: 1, to: 2 }).verses).toHaveLength(2);
    // すべての節が含むときは、外せないので、そのまま
    expect(buildQuote(verses, { from: 1, to: 2 }, undefined, { avoid: /滅/ }).verses).toHaveLength(
      2,
    );
    // 含む節がなければ、変わらない
    expect(buildQuote(five, { from: 1, to: 5 }, undefined, { avoid: /滅/ }).verses).toHaveLength(5);
  });

  it("節がなければ、空", () => {
    expect(buildQuote([])).toEqual({ from: 0, to: 0, text: "", verses: [], partial: false });
  });
});
