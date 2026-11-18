import { describe, expect, it } from "vitest";
import { pickDistinct, sharesPhrase } from "./passage-overlap";

// 並行記事のような、同じ言い回しを含む2つの文(本文は、動作を見るための短い例)
const matt = "人をさばくな。なぜ、兄弟の目にあるちりを見ながら、自分の目にある梁を認めないのか。";
const luke =
  "盲人は盲人の手引ができようか。なぜ、兄弟の目にあるちりを見ながら、自分の目にある梁を認めないのか。悪い実のなる良い木はない。";
const other = "主はわたしの牧者であって、わたしには乏しいことがない。";

describe("sharesPhrase", () => {
  it("20字以上の同じ並びを共有していれば、true(句読点や空白は無視)", () => {
    expect(sharesPhrase(matt, luke)).toBe(true);
    expect(sharesPhrase("なぜ 兄弟の目に、ある ちりを見ながら自分の目にある梁を", luke)).toBe(true);
  });

  it("共有していなければ false。短すぎる文も false", () => {
    expect(sharesPhrase(matt, other)).toBe(false);
    expect(sharesPhrase("短い", "短い")).toBe(false);
  });

  it("n を変えられる(短い共通の言い回しだけなら、既定では重複としない)", () => {
    expect(sharesPhrase("あなたの神、主はいつくしみ深い。", "あなたの神、主は正しい。")).toBe(
      false,
    );
    expect(sharesPhrase("あなたの神、主はいつくしみ深い。", "あなたの神、主は正しい。", 6)).toBe(
      true,
    );
  });
});

describe("pickDistinct", () => {
  const p = (id: string, text: string) => ({ id, text });

  it("すでに選んだものと重複する段落は飛ばして、次の候補を選ぶ(前のものを優先する)", () => {
    const result = pickDistinct(
      [
        p("Matt.7", matt),
        p("Luke.6", luke),
        p("Ps.23", other),
        p("Next", "別の、まったく違う内容の段落です。"),
      ],
      3,
    );
    expect(result.map((r) => r.id)).toEqual(["Matt.7", "Ps.23", "Next"]);
  });

  it("重複がなければ、そのまま count 件", () => {
    const result = pickDistinct([p("a", matt), p("b", other)], 3);
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
