import { describe, expect, it } from "vitest";
import { buildTsQuery } from "./fts-query";

describe("buildTsQuery", () => {
  it("トークンを、引用符で囲んで、OR でつなぐ", () => {
    expect(buildTsQuery(["思いわずらう", "あす"])).toBe("'思いわずらう' | 'あす'");
  });

  it("重複は1つにする。順序は保つ", () => {
    expect(buildTsQuery(["あす", "思い", "あす"])).toBe("'あす' | '思い'");
  });

  it("英数字・カタカナ・長音記号を含むトークンは通す", () => {
    expect(buildTsQuery(["AI", "モーセ", "ビットコイン", "2"])).toBe(
      "'AI' | 'モーセ' | 'ビットコイン' | '2'",
    );
  });

  it("使えるトークンがなければ、undefined", () => {
    expect(buildTsQuery([])).toBeUndefined();
    expect(buildTsQuery(["ー"])).toBeDefined(); // 長音記号は文字扱い(tokenizer 側で、長音だけのトークンは捨てている)
    expect(buildTsQuery(["<->", "&", "'", "!"])).toBeUndefined();
  });

  it("tsquery の演算子や記号を含むトークンは、捨てる(構文を壊せない)", () => {
    const hostile = [
      "foo':*",
      "a&b",
      "x|y",
      "!z",
      "(w)",
      "a<->b",
      "back\\slash",
      "semi;colon",
      "a b",
    ];
    expect(buildTsQuery(hostile)).toBeUndefined();
    // 安全なトークンと混ざっていても、安全なものだけ残る
    expect(buildTsQuery(["あす", "foo':*", "思い"])).toBe("'あす' | '思い'");
  });

  it("出力に、引用符で囲んだトークンの外側の記号は、OR(|)と空白しかない", () => {
    const query = buildTsQuery(["あ", "い", "う"]);
    expect(query?.replace(/'[^']+'/g, "")).toBe(" |  | ");
  });
});
