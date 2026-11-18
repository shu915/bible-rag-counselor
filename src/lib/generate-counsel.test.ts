import { beforeEach, describe, expect, it, vi } from "vitest";

// 本物の OpenRouter は呼ばない(chatText を差し替える)
const chat = vi.hoisted(() => ({ chatText: vi.fn() }));
vi.mock("./openrouter", () => ({ chatText: chat.chatText }));

import {
  buildUserMessage,
  generateCounsel,
  GenerationError,
  parseCounsel,
  removePhoneNumbers,
  type PassageInput,
} from "./generate-counsel";
import { MAX_QUERY_CHARS } from "./tokenizer";

const passages: PassageInput[] = [
  { id: "Ps.13.1-6", text: "主よ、いつまでなのですか。" },
  { id: "Matt.11.28-30", text: "すべて重荷を負うて苦労している者は、わたしのもとにきなさい。" },
  { id: "Eccl.4.6", text: "片手に物を満たして平穏であるのは、…" },
];
const ids = passages.map((p) => p.id);

const goodJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    crisis: false,
    preface: null,
    commentaries: [
      { id: "Ps.13.1-6", commentary: "つらい気持ちを、昔の人も言葉にしていました。" },
      { id: "Matt.11.28-30", commentary: "休んでいい、という声があります。" },
      { id: "Eccl.4.6", commentary: "ほどほどでよい、という考え方もあります。" },
    ],
    conclusion: "今日は、早く休みましょう。",
    ...overrides,
  });

describe("parseCounsel", () => {
  it("返答を、入力の箇所の順に整える", () => {
    const shuffled = goodJson({
      commentaries: [
        { id: "Eccl.4.6", commentary: "三" },
        { id: "Ps.13.1-6", commentary: "一" },
        { id: "Matt.11.28-30", commentary: "二" },
      ],
    });
    const result = parseCounsel(shuffled, ids);
    expect(result.commentaries.map((c) => c.id)).toEqual(ids);
    expect(result.commentaries.map((c) => c.commentary)).toEqual(["一", "二", "三"]);
    expect(result.crisis).toBe(false);
    expect(result.preface).toBeNull();
  });

  it("前後に説明やコードブロックの記号があっても、JSON を読む", () => {
    const text = `はい、どうぞ。\n\`\`\`json\n${goodJson()}\n\`\`\`\n以上です。`;
    expect(parseCounsel(text, ids).conclusion).toBe("今日は、早く休みましょう。");
  });

  it("入力にない id(作り話・書き間違い)は捨てる。重複は、最初のものだけ", () => {
    const text = goodJson({
      commentaries: [
        { id: "Gen.1.1", commentary: "作り話" },
        { id: "Ps.13.1-6", commentary: "一" },
        { id: "Ps.13.1-6", commentary: "重複" },
        { id: "Matt.11.28-30", commentary: "二" },
        { id: "Eccl.4.6", commentary: "三" },
      ],
    });
    const result = parseCounsel(text, ids);
    expect(result.commentaries.map((c) => c.commentary)).toEqual(["一", "二", "三"]);
  });

  it("どれかの箇所に解説がなければ、止まる(解説のない引用を出さない)", () => {
    const missing = goodJson({
      commentaries: [
        { id: "Ps.13.1-6", commentary: "一" },
        { id: "Matt.11.28-30", commentary: "  " },
        { id: "Eccl.4.6", commentary: "三" },
      ],
    });
    expect(() => parseCounsel(missing, ids)).toThrow(GenerationError);
  });

  it("結論が空・JSON でない・形が違う返答は、止まる", () => {
    expect(() => parseCounsel(goodJson({ conclusion: " " }), ids)).toThrow(GenerationError);
    expect(() => parseCounsel("申し訳ありません", ids)).toThrow(GenerationError);
    expect(() => parseCounsel("{ これは JSON ではない }", ids)).toThrow(GenerationError);
    expect(() => parseCounsel('{"commentaries": "x", "conclusion": "y"}', ids)).toThrow(
      GenerationError,
    );
  });

  it("preface と crisis を読む", () => {
    const result = parseCounsel(
      goodJson({
        preface: "それは聖書には載っていませんが、比べる気持ちとして受け止めます。",
        crisis: true,
      }),
      ids,
    );
    expect(result.preface).toContain("聖書には載っていませんが");
    expect(result.crisis).toBe(true);
  });

  it("エラーのメッセージに、返答の中身を入れない", () => {
    const secret = "上司に言えない秘密の悩み";
    const error = (() => {
      try {
        parseCounsel(`{"commentaries": "${secret}", "conclusion": "x"}`, ids);
      } catch (e) {
        return e;
      }
    })();
    expect(String(error)).not.toContain(secret);
  });
});

describe("引用する節の範囲", () => {
  const verses = [
    { verse: 1, verse_end: 1, text: "一節目。" },
    { verse: 2, verse_end: 2, text: "二節目。" },
    { verse: 3, verse_end: 3, text: "三節目。" },
  ];
  const versesById = new Map([["Ps.13.1-6", verses]]);
  const withQuote = (from: unknown, to: unknown): string =>
    goodJson({
      commentaries: [
        { id: "Ps.13.1-6", commentary: "一", quote_from: from, quote_to: to },
        { id: "Matt.11.28-30", commentary: "二" },
        { id: "Eccl.4.6", commentary: "三" },
      ],
    });

  it("節の番号つきで、AI に見せる(範囲を、番号で選ばせるため)", () => {
    const message = buildUserMessage("悩み", [{ id: "Ps.13.1-6", text: "x", verses }], 900);
    expect(message).toContain("(1) 一節目。\n(2) 二節目。\n(3) 三節目。");
  });

  it("使える範囲(段落の節に収まる整数の組)だけを、quote として返す", () => {
    const ok = parseCounsel(withQuote(2, 3), ids, versesById);
    expect(ok.commentaries[0].quote).toEqual({ from: 2, to: 3 });
    // 範囲を返していない箇所は、quote なし
    expect(ok.commentaries[1].quote).toBeUndefined();
  });

  it("範囲外・逆順・小数・文字列は、捨てる(quote なし。呼び出し側が先頭から短く切る)", () => {
    for (const [from, to] of [
      [0, 2],
      [2, 9],
      [3, 1],
      [1.5, 2],
      ["1", "2"],
    ]) {
      expect(
        parseCounsel(withQuote(from, to), ids, versesById).commentaries[0].quote,
      ).toBeUndefined();
    }
  });

  it("核心の節(core)は、引用する範囲に収まるときだけ返す。外れていれば、捨てる", () => {
    const withCore = (qf: number, qt: number, cf: unknown, ct: unknown): string =>
      goodJson({
        commentaries: [
          {
            id: "Ps.13.1-6",
            commentary: "一",
            quote_from: qf,
            quote_to: qt,
            core_from: cf,
            core_to: ct,
          },
          { id: "Matt.11.28-30", commentary: "二" },
          { id: "Eccl.4.6", commentary: "三" },
        ],
      });
    const ok = parseCounsel(withCore(1, 3, 2, 2), ids, versesById).commentaries[0];
    expect(ok.quote).toEqual({ from: 1, to: 3 });
    expect(ok.core).toEqual({ from: 2, to: 2 });
    // 引用する範囲の外・型が違う核心は、捨てる(引用の範囲は、残る)
    const outside = parseCounsel(withCore(1, 2, 3, 3), ids, versesById).commentaries[0];
    expect(outside.quote).toEqual({ from: 1, to: 2 });
    expect(outside.core).toBeUndefined();
    expect(
      parseCounsel(withCore(1, 3, "2", "2"), ids, versesById).commentaries[0].core,
    ).toBeUndefined();
  });

  it("プロンプトに、太字にする核心の節(core_from)と、意味が通じる長さの規則が入っている", async () => {
    chat.chatText.mockResolvedValueOnce({ text: goodJson(), usage: {} });
    await generateCounsel("悩み", passages);
    const system = chat.chatText.mock.calls.at(-1)?.[0].system as string;
    expect(system).toContain("core_from");
    expect(system).toContain("意味が通じる");
  });

  it("節の情報を渡さなければ、quote は付かない", () => {
    expect(parseCounsel(withQuote(1, 2), ids).commentaries[0].quote).toBeUndefined();
  });

  it("プロンプトに、引用の範囲の規則が入っている", async () => {
    chat.chatText.mockResolvedValueOnce({ text: goodJson(), usage: {} });
    await generateCounsel("悩み", passages);
    const system = chat.chatText.mock.calls.at(-1)?.[0].system as string;
    expect(system).toContain("quote_from");
    expect(system).toContain("1節だけでは意味が通じないとき");
  });
});

describe("読む順(order)", () => {
  const withOrder = (order: unknown): string => goodJson({ order });

  it("入力の id の並べ替えになっていれば、その順(読む順)にする", () => {
    const result = parseCounsel(withOrder(["Eccl.4.6", "Ps.13.1-6", "Matt.11.28-30"]), ids);
    expect(result.commentaries.map((c) => c.id)).toEqual([
      "Eccl.4.6",
      "Ps.13.1-6",
      "Matt.11.28-30",
    ]);
  });

  it("order がない・数が違う・重複・入力にない id のときは、入力の順のまま", () => {
    for (const order of [
      undefined,
      ["Ps.13.1-6"],
      ["Ps.13.1-6", "Ps.13.1-6", "Eccl.4.6"],
      ["Gen.1.1", "Ps.13.1-6", "Eccl.4.6"],
      "Ps.13.1-6",
    ]) {
      expect(parseCounsel(withOrder(order), ids).commentaries.map((c) => c.id)).toEqual(ids);
    }
  });

  it("プロンプトに、役割は内容で決める・読む順は order、と書いてある(位置で役割を決めない)", async () => {
    chat.chatText.mockResolvedValueOnce({ text: goodJson(), usage: {} });
    await generateCounsel("悩み", passages);
    const request = chat.chatText.mock.calls.at(-1)?.[0];
    expect(request.system).toContain("役割は、**箇所の内容**で決める");
    expect(request.system).toContain("order に、読む順で");
    expect(request.system).not.toContain("1つ目(受け止める)");
    expect(request.user).toContain("読む順は、order で決める");
  });
});

describe("電話番号を、AI が書かない(書いても、取り除く)", () => {
  it("removePhoneNumbers: 括弧の中の番号は、括弧ごと。番号だけの場合は、番号を取り除く", () => {
    expect(
      removePhoneNumbers("よりそいホットライン(0120-279-338、24時間・無料)に連絡してください"),
    ).toBe("よりそいホットラインに連絡してください");
    expect(removePhoneNumbers("0120-279-338 に電話")).toBe(" に電話");
    expect(removePhoneNumbers("050-1234-5678")).toBe("");
    expect(removePhoneNumbers("03(1234)5678")).toBe("03(1234)5678"); // 区切りが違う形は、対象外
  });

  it("区切りのない番号・全角の番号・短縮の番号も、取り除く(第4回のレビュー)", () => {
    expect(removePhoneNumbers("0120279338 に電話")).toBe(" に電話");
    // 番号が括弧の外にあるときは、番号だけを取り除く(括弧ごとは、括弧の中に番号があるときだけ)
    expect(removePhoneNumbers("０１２０−２７９−３３８(24時間)に電話")).toBe("(24時間)に電話");
    expect(removePhoneNumbers("電話相談 #9110 や #7119")).toBe("電話相談  や ");
    expect(removePhoneNumbers("よりそいホットライン(０１２０－２７９－３３８)")).toBe(
      "よりそいホットライン",
    );
  });

  it("聖書の節の番号・日付・年は、取り除かない", () => {
    for (const text of [
      "ヨブ記 7:11-21 の箇所",
      "1954年の訳",
      "11-21節",
      "119番や110番",
      "2026-11-18",
    ]) {
      expect(removePhoneNumbers(text)).toBe(text);
    }
  });

  it("parseCounsel は、解説・結論・前置きから、電話番号を取り除く", () => {
    const text = goodJson({
      preface: "前置き(0120-279-338)です。",
      commentaries: [
        { id: "Ps.13.1-6", commentary: "解説 0120-279-338 です" },
        { id: "Matt.11.28-30", commentary: "二" },
        { id: "Eccl.4.6", commentary: "三" },
      ],
      conclusion: "窓口(03-1234-5678、24時間)に話してください。",
    });
    const result = parseCounsel(text, ids);
    expect(result.preface).toBe("前置きです。");
    expect(result.commentaries[0].commentary).toBe("解説  です");
    expect(result.conclusion).toBe("窓口に話してください。");
  });

  it("プロンプトに、電話番号・窓口の名前・受付時間を書かない規則が入っている", async () => {
    chat.chatText.mockResolvedValueOnce({ text: goodJson(), usage: {} });
    await generateCounsel("悩み", passages);
    expect(chat.chatText.mock.calls.at(-1)?.[0].system).toContain(
      "電話番号・相談窓口の名前・受付時間は、書かない",
    );
  });
});

describe("命の危険の文脈(crisisContext)", () => {
  it("指定したときだけ、専用の指示(受け止める・肯定も否定もしない・窓口を書かない・1人に伝える)を足す", async () => {
    chat.chatText.mockResolvedValue({ text: goodJson(), usage: {} });
    await generateCounsel("悩み", passages);
    expect(chat.chatText.mock.calls.at(-1)?.[0].system).not.toContain(
      "死にたい気持ちを書いている可能性",
    );

    await generateCounsel("悩み", passages, { crisisContext: true });
    const system = chat.chatText.mock.calls.at(-1)?.[0].system as string;
    expect(system).toContain("死にたい気持ちを書いている可能性");
    expect(system).toContain("肯定も否定もせず");
    expect(system).toContain("死を望む言葉が、箇所にあれば");
    expect(system).toContain("誰か1人に");
  });
});

describe("他人を傷つけたい気持ち(harmContext)", () => {
  it("指定したときだけ、専用の指示(神が代わりに罰する、と読ませない・その場を離れる・緊急の窓口)を足す", async () => {
    chat.chatText.mockResolvedValue({ text: goodJson(), usage: {} });
    await generateCounsel("悩み", passages);
    expect(chat.chatText.mock.calls.at(-1)?.[0].system).not.toContain(
      "傷つけたい気持ちを書いています",
    );

    await generateCounsel("悩み", passages, { harmContext: true });
    const system = chat.chatText.mock.calls.at(-1)?.[0].system as string;
    expect(system).toContain("傷つけたい気持ちを書いています");
    expect(system).toContain("神が代わりに、相手を罰してくれる、という読みにしない");
    expect(system).toContain("緊急の窓口に連絡する");
    // 自傷の指示とは、別(混ざらない)
    expect(system).not.toContain("死にたい気持ちを書いている可能性");
  });
});

describe("buildUserMessage", () => {
  it("悩みと、番号・id・本文を並べる。長い本文は、冒頭で切る", () => {
    const message = buildUserMessage("疲れた", [{ id: "A.1.1", text: "あ".repeat(20) }], 5);
    expect(message).toContain("【悩み】\n疲れた");
    expect(message).toContain("[1] id: A.1.1\nあああああ…");
  });
});

describe("generateCounsel", () => {
  beforeEach(() => {
    chat.chatText.mockReset();
  });

  it("解説と結論を返す。推論は low、費用の見積もりも返す", async () => {
    chat.chatText.mockResolvedValueOnce({
      text: goodJson(),
      usage: { promptTokens: 1500, completionTokens: 800 },
    });
    const result = await generateCounsel("仕事で疲れ果てた", passages);
    expect(result.commentaries).toHaveLength(3);
    expect(result.usage).toEqual({ promptTokens: 1500, completionTokens: 800 });

    const request = chat.chatText.mock.calls[0][0];
    expect(request.reasoningEffort).toBe("low");
    // 解説と結論は、「書く仕事」(OPENROUTER_WRITING_MODEL があれば、そのモデル)
    expect(request.purpose).toBe("writing");
    expect(request.user).toContain("仕事で疲れ果てた");
    expect(request.user).toContain("id: Matt.11.28-30");
    // 規則が、プロンプトに入っている
    expect(request.system).toContain("信仰を前提にしない");
    expect(request.system).toContain("耐えるよう勧めない");
    expect(request.system).toContain("病気は、神の怒りや罰ではない");
    expect(request.system).toContain("相談者が書いていないことを、決めつけない");
    expect(request.system).toContain("箇所にない意味");
    expect(request.system).toContain("責めるように、罰するように読める節");
    expect(request.system).toContain("お話からは分かりませんが");
    expect(request.system).toContain("逆に働く");
    expect(request.system).toContain("「空である」「苦しい」で終わる箇所は、最後にしない");
    expect(request.system).toContain("言い換えない");
    expect(request.system).toContain("この断りを書かない");
    expect(request.system).toContain("事実として肯定しない");
  });

  it("全体の締め切り(signal)を、OpenRouter の呼び出しに渡す", async () => {
    chat.chatText.mockResolvedValueOnce({ text: goodJson(), usage: {} });
    const controller = new AbortController();
    await generateCounsel("悩み", passages, { signal: controller.signal });
    expect(chat.chatText.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });

  it("空の悩み・長すぎる悩み・箇所なしは、モデルを呼ばずに断る", async () => {
    await expect(generateCounsel("  ", passages)).rejects.toThrow(RangeError);
    await expect(generateCounsel("あ".repeat(MAX_QUERY_CHARS + 1), passages)).rejects.toThrow(
      RangeError,
    );
    await expect(generateCounsel("悩み", [])).rejects.toThrow(RangeError);
    expect(chat.chatText).not.toHaveBeenCalled();
  });

  it("返答が崩れていたら、GenerationError(やり直しは、呼び出し側が決める)", async () => {
    chat.chatText.mockResolvedValueOnce({ text: "すみません、できません", usage: {} });
    await expect(generateCounsel("悩み", passages)).rejects.toThrow(GenerationError);
  });
});
