import { describe, expect, it } from "vitest";
import { dropUnseenQuotes } from "./commentary-check";

const shown = "主よ、わたしはあなたに寄り頼みます。わたしの時は、あなたのみ手にあります。";
const hidden = "わたしを敵の手から救い出してください。あなたのしもべを顔の光で照らしてください。";

describe("dropUnseenQuotes", () => {
  it("画面に出ない節にだけある言葉を「」で引いた文を、落とす", () => {
    const commentary =
      "ここは、寄り頼む祈りです。「あなたのしもべを顔の光で照らしてください」という願いも続きます。最後に、静かに終わります。";
    expect(dropUnseenQuotes(commentary, shown, hidden)).toBe(
      "ここは、寄り頼む祈りです。最後に、静かに終わります。",
    );
  });

  it("画面に出る節の言葉を引いた文は、残す", () => {
    const commentary = "「わたしの時は、あなたのみ手にあります」と語ります。";
    expect(dropUnseenQuotes(commentary, shown, hidden)).toBe(commentary);
  });

  it("どの節にもない言葉(相談者の言葉・言い換え)は、残す", () => {
    const commentary = "「何をしているのか分からない」というお気持ちと、重なるかもしれません。";
    expect(dropUnseenQuotes(commentary, shown, hidden)).toBe(commentary);
  });

  it("全角・半角、空白、句読点の違いを、そろえて比べる", () => {
    const commentary = "「あなたのしもべを、顔の 光で照らして ください」とあります。";
    expect(dropUnseenQuotes(commentary + "続きです。", shown, hidden)).toBe("続きです。");
  });

  it("4字の語句も調べる(範囲の外にだけある「空である」のような引用を、落とす)", () => {
    expect(
      dropUnseenQuotes(
        "静かな祈りです。「光を見る」とも語ります。続きです。",
        shown,
        "あなたの顔の光を見ることができる",
      ),
    ).toBe("静かな祈りです。続きです。");
  });

  it("短い語句(4字未満)は、調べない(偶然の一致で、誤って落とさない)", () => {
    const commentary = "「救い出」とあります。";
    expect(dropUnseenQuotes(commentary, shown, hidden)).toBe(commentary);
  });

  it("語尾を言い換えた引用(「あります」を「ある」に)も、出ない節の言葉として落とす(実際に出た例)", () => {
    // 引用の範囲は 7〜14 節。15 節は、範囲の外
    const shownPs =
      "主よ、わたしは悩みのうちにあります。わたしのいのちは悲しみによって消えゆきます。";
    const hiddenPs = "しかし主よ、わたしはあなたに信頼します。わたしの時はあなたのみ手にあります。";
    const commentary =
      "悩みの中で、助けを求めています。「わたしの時はあなたのみ手にある」と、すべてを委ねる言葉も続きます。静かな祈りです。";
    expect(dropUnseenQuotes(commentary, shownPs, hiddenPs)).toBe(
      "悩みの中で、助けを求めています。静かな祈りです。",
    );
  });

  it("引用符の中に「。」があっても、文を分けない(引用ごと落とす)", () => {
    const commentary =
      "祈りです。「あなたのしもべを顔の光で照らしてください。わたしを救い出してください」と続きます。終わります。";
    expect(dropUnseenQuotes(commentary, shown, hidden)).toBe("祈りです。終わります。");
  });

  it("画面に出る節にも同じ言葉があれば、残す(出る節のほうが近いとき)", () => {
    const both = "あなたのしもべを顔の光で照らしてください";
    const commentary = "「あなたのしもべを顔の光で照らしてください」とあります。続きです。";
    expect(dropUnseenQuotes(commentary, both, both)).toBe(commentary);
  });

  it("画面に出る節が1つもないときは、調べない", () => {
    const commentary = "「あなたのしもべを顔の光で照らしてください」とあります。続きです。";
    expect(dropUnseenQuotes(commentary, "", hidden)).toBe(commentary);
  });

  it("画面に出ない節がなければ、そのまま返す", () => {
    const commentary = "「あなたのしもべを顔の光で照らしてください」とあります。";
    expect(dropUnseenQuotes(commentary, shown, "")).toBe(commentary);
  });

  it("すべての文が落ちるときは、元のまま返す(空の解説にしない)", () => {
    const commentary = "「あなたのしもべを顔の光で照らしてください」とあります。";
    expect(dropUnseenQuotes(commentary, shown, hidden)).toBe(commentary);
  });

  it("「」のない解説は、そのまま返す", () => {
    const commentary = "寄り頼む祈りです。静かに終わります。";
    expect(dropUnseenQuotes(commentary, shown, hidden)).toBe(commentary);
  });
});
