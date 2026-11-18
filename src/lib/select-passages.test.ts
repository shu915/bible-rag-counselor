import { beforeEach, describe, expect, it, vi } from "vitest";

// 本物の OpenRouter は呼ばない(chatText を差し替える)
const chat = vi.hoisted(() => ({ chatText: vi.fn() }));
vi.mock("./openrouter", () => ({ chatText: chat.chatText }));

import { MAX_QUERY_CHARS } from "./tokenizer";
import {
  buildUserMessage,
  fillSelection,
  parseSelection,
  selectPassages,
  truncate,
  type Candidate,
} from "./select-passages";

const candidates: Candidate[] = [
  { id: "Matt.6.25-34", text: "あすのことを思いわずらうな" },
  { id: "1John.1.5-10", text: "もし、わたしたちが自分の罪を告白するならば" },
  { id: "Eccl.5.10", text: "金銭を好む者は金銭をもって満足しない" },
  { id: "Ps.51.1-19", text: "神よ、あなたのいつくしみによって" },
];
const ids = new Set(candidates.map((c) => c.id));

describe("parseSelection", () => {
  it("候補にある id を、出てきた順に取り出す", () => {
    expect(parseSelection("Ps.51.1-19\nMatt.6.25-34\n1John.1.5-10", ids, 3)).toEqual([
      "Ps.51.1-19",
      "Matt.6.25-34",
      "1John.1.5-10",
    ]);
  });

  it("候補にない id(作り話・書き間違い)は捨てる", () => {
    expect(parseSelection("Gen.1.1-3\nMatt.6.25-33\nEccl.5.10", ids, 3)).toEqual(["Eccl.5.10"]);
  });

  it("前後に説明や記号があっても、id だけを拾う。重複は1つにする", () => {
    expect(
      parseSelection("1. id: Matt.6.25-34 (理由)\n- Matt.6.25-34\n「Ps.51.1-19」", ids, 3),
    ).toEqual(["Matt.6.25-34", "Ps.51.1-19"]);
  });

  it("数字で始まる書(1John)の id も拾える。多すぎるときは、先頭の count 件", () => {
    expect(parseSelection("1John.1.5-10\nMatt.6.25-34\nEccl.5.10\nPs.51.1-19", ids, 2)).toEqual([
      "1John.1.5-10",
      "Matt.6.25-34",
    ]);
  });

  it("1件も拾えなければ、空の配列", () => {
    expect(parseSelection("該当なし", ids, 3)).toEqual([]);
  });
});

describe("fillSelection(選んだ数が足りないときの補い)", () => {
  const all = candidates.map((c) => c.id);

  it("count 件に満たなければ、候補を前から、重複しないように足す", () => {
    expect(fillSelection(["Eccl.5.10"], all, 3)).toEqual([
      "Eccl.5.10",
      "Matt.6.25-34",
      "1John.1.5-10",
    ]);
  });

  it("1件も選ばれなければ、候補の上位 count 件", () => {
    expect(fillSelection([], all, 3)).toEqual(all.slice(0, 3));
  });

  it("すでに足りていれば、そのまま。候補が足りなければ、ある分だけ", () => {
    expect(fillSelection(["a", "b", "c"], all, 3)).toEqual(["a", "b", "c"]);
    expect(fillSelection([], ["x"], 3)).toEqual(["x"]);
  });
});

describe("truncate / buildUserMessage", () => {
  it("長い本文は、冒頭だけにして、省略を示す", () => {
    expect(truncate("あいうえお", 3)).toBe("あいう…");
    expect(truncate("あいう", 3)).toBe("あいう");
  });

  it("悩みと、番号・id・本文の冒頭を並べる", () => {
    const message = buildUserMessage("明日が不安", candidates.slice(0, 2), 5);
    expect(message).toContain("【悩み】\n明日が不安");
    expect(message).toContain("[1] id: Matt.6.25-34\nあすのこと…");
    expect(message).toContain("[2] id: 1John.1.5-10");
  });
});

describe("selectPassages", () => {
  beforeEach(() => {
    chat.chatText.mockReset();
  });

  it("モデルの返答から、候補にある id だけを選ぶ。推論は最小、温度は 0", async () => {
    chat.chatText.mockResolvedValueOnce({
      text: "Matt.6.25-34\nGen.1.1\nEccl.5.10",
      usage: { promptTokens: 900, completionTokens: 60 },
    });
    const result = await selectPassages("お金が不安", candidates);

    expect(result.ids).toEqual(["Matt.6.25-34", "Eccl.5.10"]);
    expect(result.usage).toEqual({ promptTokens: 900, completionTokens: 60 });

    const request = chat.chatText.mock.calls[0][0];
    expect(request.temperature).toBe(0);
    expect(request.reasoningEffort).toBe("minimal");
    expect(request.user).toContain("お金が不安");
    expect(request.user).toContain("id: Ps.51.1-19");
  });

  it("本文は、maxCharsPerCandidate で切って渡す", async () => {
    chat.chatText.mockResolvedValueOnce({ text: "Matt.6.25-34", usage: {} });
    await selectPassages("悩み", [{ id: "Matt.6.25-34", text: "あ".repeat(100) }], {
      maxCharsPerCandidate: 10,
    });
    expect(chat.chatText.mock.calls[0][0].user).toContain(`${"あ".repeat(10)}…`);
    expect(chat.chatText.mock.calls[0][0].user).not.toContain("あ".repeat(11));
  });

  it("selectPassages は、LLM の選択だけを返す(補わない)。補うのは、呼び出し側が fillSelection で行う", async () => {
    chat.chatText.mockResolvedValueOnce({ text: "Matt.6.25-34\nGen.1.1", usage: {} });
    const result = await selectPassages("悩み", candidates);
    expect(result.ids).toEqual(["Matt.6.25-34"]);
    expect(
      fillSelection(
        result.ids,
        candidates.map((c) => c.id),
        3,
      ),
    ).toEqual(["Matt.6.25-34", "1John.1.5-10", "Eccl.5.10"]);
  });

  it("本文の既定の長さは150字", async () => {
    chat.chatText.mockResolvedValueOnce({ text: "Matt.6.25-34", usage: {} });
    await selectPassages("悩み", [{ id: "Matt.6.25-34", text: "あ".repeat(300) }]);
    const user = chat.chatText.mock.calls[0][0].user;
    expect(user).toContain(`${"あ".repeat(150)}…`);
    expect(user).not.toContain("あ".repeat(151));
  });

  it("空の悩み・長すぎる悩み・候補なしは、モデルを呼ばずに断る", async () => {
    await expect(selectPassages("  ", candidates)).rejects.toThrow(RangeError);
    await expect(selectPassages("あ".repeat(MAX_QUERY_CHARS + 1), candidates)).rejects.toThrow(
      RangeError,
    );
    await expect(selectPassages("悩み", [])).rejects.toThrow(RangeError);
    expect(chat.chatText).not.toHaveBeenCalled();
  });
});
