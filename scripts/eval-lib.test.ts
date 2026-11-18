import { describe, expect, it } from "vitest";
import { evalFileSchema, firstRank, rrfFuse, summarize } from "./eval-lib";

describe("firstRank", () => {
  it("正解のどれかが最初に出た順位(1から)を返す", () => {
    expect(firstRank(["a", "b", "c"], ["c", "b"])).toBe(2);
    expect(firstRank(["a", "b"], ["a"])).toBe(1);
  });

  it("正解が無ければ undefined", () => {
    expect(firstRank(["a", "b"], ["z"])).toBeUndefined();
    expect(firstRank([], ["a"])).toBeUndefined();
  });
});

describe("summarize", () => {
  it("上位1・3・10件の割合と、平均逆順位を出す", () => {
    // 1位、2位、5位、11位、圏外
    const s = summarize([1, 2, 5, 11, undefined]);
    expect(s.count).toBe(5);
    expect(s.hitAt1).toBeCloseTo(1 / 5);
    expect(s.hitAt3).toBeCloseTo(2 / 5);
    expect(s.hitAt10).toBeCloseTo(3 / 5);
    expect(s.mrr).toBeCloseTo((1 + 1 / 2 + 1 / 5 + 1 / 11 + 0) / 5);
    // 11位は、15件以内。圏外は、どの k にも入らない
    expect(s.hitAt15).toBeCloseTo(4 / 5);
    expect(summarize([16, 21, 31, undefined]).hitAt15).toBe(0);
    expect(summarize([16, 21, 31, undefined]).hitAt20).toBe(1 / 4);
    expect(summarize([16, 21, 31, undefined]).hitAt30).toBe(2 / 4);
  });

  it("全部1位なら、すべて 1", () => {
    expect(summarize([1, 1])).toEqual({
      count: 2,
      hitAt1: 1,
      hitAt3: 1,
      hitAt10: 1,
      hitAt15: 1,
      hitAt20: 1,
      hitAt30: 1,
      mrr: 1,
    });
  });

  it("空なら、すべて 0(0で割らない)", () => {
    expect(summarize([])).toEqual({
      count: 0,
      hitAt1: 0,
      hitAt3: 0,
      hitAt10: 0,
      hitAt15: 0,
      hitAt20: 0,
      hitAt30: 0,
      mrr: 0,
    });
  });
});

describe("evalFileSchema", () => {
  const base = { description: "d", status: "reviewed" };

  it("正しい形は通る", () => {
    expect(
      evalFileSchema.safeParse({ ...base, cases: [{ id: "q1", query: "悩み", expected: ["a"] }] })
        .success,
    ).toBe(true);
  });

  it("split と reviewed は、省略できる。dev / holdout 以外の split は、はじく", () => {
    const ok = {
      ...base,
      cases: [{ id: "q1", query: "悩み", expected: ["a"], split: "holdout", reviewed: false }],
    };
    expect(evalFileSchema.safeParse(ok).success).toBe(true);
    const bad = { ...base, cases: [{ id: "q1", query: "悩み", expected: ["a"], split: "test" }] };
    expect(evalFileSchema.safeParse(bad).success).toBe(false);
  });

  it("正解が空の問いは、はじく", () => {
    expect(
      evalFileSchema.safeParse({ ...base, cases: [{ id: "q1", query: "悩み", expected: [] }] })
        .success,
    ).toBe(false);
  });
});

describe("rrfFuse", () => {
  it("どちらのリストでも上位にあるものが、先頭に来る", () => {
    expect(
      rrfFuse([
        ["a", "b", "c"],
        ["b", "a", "d"],
      ]),
    ).toEqual(["a", "b", "c", "d"]);
    expect(
      rrfFuse([
        ["x", "b", "c"],
        ["y", "b", "d"],
      ])[0],
    ).toBe("b");
  });

  it("1つのリストにしかないものも、残す。リスト1つなら、順序は変わらない", () => {
    expect(rrfFuse([["a", "b", "c"]])).toEqual(["a", "b", "c"]);
    expect(rrfFuse([["a"], ["z"]])).toEqual(["a", "z"]);
  });

  it("空なら、空", () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], []])).toEqual([]);
  });
});
