import { beforeEach, describe, expect, it, vi } from "vitest";

// 本物の OpenRouter は呼ばない(chatText を差し替える)
const chat = vi.hoisted(() => ({ chatText: vi.fn() }));
vi.mock("./openrouter", () => ({ chatText: chat.chatText }));

import { MAX_QUERY_CHARS } from "./tokenizer";
import { parseRewrites, rewriteQuery } from "./rewrite-query";

describe("parseRewrites", () => {
  it("1行に1つの検索文を、配列にする", () => {
    expect(parseRewrites("あすのことを思いわずらうな\n労する者は休ませる\n涙をぬぐう")).toEqual([
      "あすのことを思いわずらうな",
      "労する者は休ませる",
      "涙をぬぐう",
    ]);
  });

  it("番号・記号・かぎ括弧を取り除く", () => {
    expect(
      parseRewrites("1. 思いわずらうな\n2) 「重荷を負う者」\n- ・休ませよう\n・ なぐさめ"),
    ).toEqual(["思いわずらうな", "重荷を負う者", "休ませよう", "なぐさめ"]);
  });

  it("空行と、重複と、長すぎる行を捨てる", () => {
    const tooLong = "あ".repeat(121);
    expect(parseRewrites(`\n思いわずらうな\n思いわずらうな\n${tooLong}\n\n涙`)).toEqual([
      "思いわずらうな",
      "涙",
    ]);
  });

  it("多すぎるときは、先頭の5つだけ", () => {
    expect(parseRewrites("a\nb\nc\nd\ne\nf\ng")).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("1行も拾えなければ、止まる", () => {
    expect(() => parseRewrites("\n  \n")).toThrow("取り出せません");
  });
});

describe("rewriteQuery", () => {
  beforeEach(() => {
    chat.chatText.mockReset();
  });

  it("モデルの返答を、検索文にして返す。推論は最小にして、費用の情報も返す", async () => {
    chat.chatText.mockResolvedValueOnce({
      text: "思いわずらうな\n休ませよう",
      usage: { promptTokens: 300, completionTokens: 40 },
    });
    const result = await rewriteQuery("明日が不安");

    expect(result.queries).toEqual(["思いわずらうな", "休ませよう"]);
    expect(result.usage).toEqual({ promptTokens: 300, completionTokens: 40 });

    const request = chat.chatText.mock.calls[0][0];
    expect(request.user).toBe("明日が不安");
    expect(request.reasoningEffort).toBe("minimal");
    expect(request.system).toContain("口語訳");
  });

  it("空の相談文と、長すぎる相談文は、モデルを呼ばずに断る", async () => {
    await expect(rewriteQuery("  ")).rejects.toThrow(RangeError);
    await expect(rewriteQuery("あ".repeat(MAX_QUERY_CHARS + 1))).rejects.toThrow(RangeError);
    expect(chat.chatText).not.toHaveBeenCalled();
  });

  it("モデルの返答から検索文が取れなければ、止まる(相談文は、エラーに含めない)", async () => {
    chat.chatText.mockResolvedValueOnce({ text: "\n \n", usage: {} });
    const error = await rewriteQuery("上司に言えない秘密の悩み").catch((e: unknown) => e);
    expect(String(error)).toContain("取り出せません");
    expect(String(error)).not.toContain("秘密の悩み");
  });
});
