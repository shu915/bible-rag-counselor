import { describe, expect, it, vi } from "vitest";

// 辞書の読み込みに失敗したあと、次の呼び出しでやり直せるか(失敗した Promise を使い回さない)。
// 辞書の読み込みだけを、偽物に差し替える(実物の辞書を壊さずに、失敗を再現するため)
const state = vi.hoisted(() => ({ builds: 0 }));

vi.mock("@patdx/kuromoji", () => ({
  TokenizerBuilder: class {
    build(): Promise<{ tokenize: () => never[] }> {
      state.builds += 1;
      return state.builds === 1
        ? Promise.reject(new Error("辞書が読めない"))
        : Promise.resolve({ tokenize: () => [] });
    }
  },
}));
vi.mock("@patdx/kuromoji/node", () => ({ default: class {} }));

import { tokenize } from "./tokenizer";

describe("辞書の読み込みの失敗", () => {
  // 状態(読み込みの回数)を、順に確かめる1つのテスト。実行順や単独実行に左右されない
  it("失敗したら例外にして、次の呼び出しでやり直し、成功したあとは使い回す", async () => {
    await expect(tokenize("あ")).rejects.toThrow("辞書が読めない");
    expect(state.builds).toBe(1);

    await expect(tokenize("あ")).resolves.toEqual([]);
    expect(state.builds).toBe(2);

    await tokenize("い");
    expect(state.builds).toBe(2);
  });
});
