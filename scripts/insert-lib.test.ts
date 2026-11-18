import { describe, expect, it } from "vitest";
import {
  buildContent,
  describeTarget,
  isLocalHost,
  makeBatches,
  paragraphsFileSchema,
} from "./insert-lib";

describe("buildContent", () => {
  it("節の本文を、区切りなしでつなぐ", () => {
    expect(
      buildContent({
        verses: [
          { verse: 1, verse_end: 1, text: "あ" },
          { verse: 2, verse_end: 2, text: "い" },
        ],
      }),
    ).toBe("あい");
  });
});

describe("makeBatches", () => {
  const sizeOf = (s: string): number => s.length;

  it("件数の上限で分ける", () => {
    expect(makeBatches(["a", "b", "c", "d", "e"], sizeOf, { maxCount: 2, maxSize: 100 })).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
  });

  it("大きさの合計の上限でも分ける", () => {
    expect(makeBatches(["aaa", "bbb", "c"], sizeOf, { maxCount: 100, maxSize: 5 })).toEqual([
      ["aaa"],
      ["bbb", "c"],
    ]);
  });

  it("上限より大きい1件も、単独の組として残す(捨てない)", () => {
    expect(makeBatches(["aaaaaaaaaa", "b"], sizeOf, { maxCount: 100, maxSize: 5 })).toEqual([
      ["aaaaaaaaaa"],
      ["b"],
    ]);
  });

  it("空なら、空", () => {
    expect(makeBatches([], sizeOf, { maxCount: 2, maxSize: 5 })).toEqual([]);
  });

  it("分けても、順序と件数が変わらない", () => {
    const items = Array.from({ length: 257 }, (_, i) => "x".repeat((i % 7) + 1));
    const batches = makeBatches(items, sizeOf, { maxCount: 100, maxSize: 60 });
    expect(batches.flat()).toEqual(items);
    expect(batches.every((b) => b.length <= 100)).toBe(true);
  });
});

describe("describeTarget / isLocalHost", () => {
  it("ホスト・ポート・DB 名を返し、パスワードは含めない", () => {
    const target = describeTarget("postgres://user:secret@localhost:5434/bible_rag");
    expect(target.label).toBe("localhost:5434/bible_rag");
    expect(target.label).not.toContain("secret");
  });

  it("形式が不正なら、元の文字列を含めずに止まる", () => {
    expect(() => describeTarget("not a url secret")).toThrow("形式が不正");
    expect(() => describeTarget("not a url secret")).not.toThrow("secret");
  });

  it("ローカルかどうか", () => {
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("127.0.0.1")).toBe(true);
    expect(isLocalHost("ep-example-123.neon.tech")).toBe(false);
  });
});

describe("paragraphsFileSchema", () => {
  const ok = {
    id: "Matt.6.25-34",
    book_key: "Matt",
    book_name: "マタイによる福音書",
    testament: "NT",
    book_order: 40,
    chapter: 6,
    verse_start: 25,
    verse_end: 34,
    verses: [{ verse: 25, verse_end: 25, text: "あ" }],
  };

  it("正しい段落は通る", () => {
    expect(paragraphsFileSchema.safeParse([ok]).success).toBe(true);
  });

  it("旧約・新約の値や、書の番号が範囲外なら、はじく", () => {
    expect(paragraphsFileSchema.safeParse([{ ...ok, testament: "XX" }]).success).toBe(false);
    expect(paragraphsFileSchema.safeParse([{ ...ok, book_order: 67 }]).success).toBe(false);
  });

  it("節が空なら、はじく", () => {
    expect(paragraphsFileSchema.safeParse([{ ...ok, verses: [] }]).success).toBe(false);
  });
});
