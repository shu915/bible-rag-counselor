import { describe, expect, it } from "vitest";
import { MAX_QUERY_CHARS, tokenize, tokenizeQuery, tokenizeToString } from "./tokenizer";

// 実際の辞書(node_modules の IPADIC)を使う。聖書の本文は載せず、自作の短い文で確かめる
describe("tokenize(分かち書き)", () => {
  it("活用した語を原形にする(食べよう→食べる、飲もう→飲む)", async () => {
    expect(await tokenize("何を食べようか、何を飲もうか")).toEqual(["食べる", "飲む"]);
  });

  it("助詞・助動詞・記号は捨てる", async () => {
    expect(await tokenize("空の鳥を見るがよい。")).toEqual(["空", "鳥", "見る", "よい"]);
  });

  it("代名詞・非自立の語・「する」などの汎用の動詞は捨てる", async () => {
    // あなた(代名詞)、こと(非自立)、いる・する・できる(汎用)
    expect(await tokenize("あなたは勉強していることができる")).toEqual(["勉強"]);
  });

  it("「あなたがた」の「がた」や、「ない」は捨てる", async () => {
    expect(await tokenize("あなたがたは悲しくない")).toEqual(["悲しい"]);
  });

  it("愛しています → 愛す(辞書の原形)", async () => {
    // 辞書の原形は「愛する」ではなく「愛す」。文書側と検索側が同じ関数なら一致する
    expect(await tokenize("愛しています")).toEqual(["愛す"]);
  });

  it("文書側と検索側で、活用が違っても同じ原形になる", async () => {
    expect(await tokenize("愛した")).toEqual(await tokenize("愛している"));
  });

  it("辞書にない語(原形が * になる語)は、表層形のまま残す", async () => {
    // "AI" は辞書にない。原形の * を返してしまうと、記号扱いで捨てられて空になる
    expect(await tokenize("AI")).toEqual(["AI"]);
  });

  it("全角の英数字をそろえる(NFKC)", async () => {
    expect(await tokenize("ＡＩが不安だ")).toEqual(await tokenize("AIが不安だ"));
  });

  it("空の文字列は、空の配列", async () => {
    expect(await tokenize("")).toEqual([]);
    expect(await tokenize("です。")).toEqual([]);
  });

  it("tokenizeToString は空白区切りの文字列にする", async () => {
    expect(await tokenizeToString("何を食べようか、何を飲もうか")).toBe("食べる 飲む");
  });
});

describe("tokenize(連続するカタカナ)", () => {
  it("人名を割らずに1つのトークンにする(モーセ、ペテロ)", async () => {
    expect(await tokenize("モーセは言った")).toEqual(["モーセ", "言う"]);
    expect(await tokenize("ペテロが答えた")).toEqual(["ペテロ", "答える"]);
  });

  it("人名の断片が、別の語に当たらない(「テロ」と「ペテロ」は別)", async () => {
    expect(await tokenize("テロ")).toEqual(["テロ"]);
    expect(await tokenize("テロ")).not.toEqual(await tokenize("ペテロ"));
  });

  it("カタカナと、そのほかの語の順序を保つ", async () => {
    expect(await tokenize("ダビデの子ソロモンは王になった")).toEqual([
      "ダビデ",
      "子",
      "ソロモン",
      "王",
    ]);
  });

  it("現代のカタカナ語も、1つのトークンにする", async () => {
    expect(await tokenize("ビットコインで損をした")).toEqual(["ビットコイン", "損"]);
  });

  it("半角カナは、全角にそろえてから扱う", async () => {
    expect(await tokenize("ﾓｰｾ")).toEqual(["モーセ"]);
  });
});

describe("tokenize(記号)", () => {
  it("記号だけのトークンは残さない(to_tsquery を壊す文字)", async () => {
    const tokens = await tokenize("foo':*&|!(x) a<->b \\ ; -- DROP");
    // 文字か数字を含まないトークンは、1つもない
    expect(tokens.filter((t) => !/[\p{L}\p{N}]/u.test(t))).toEqual([]);
  });

  it("全角の記号(NFKC で ASCII になるもの)も残さない", async () => {
    const tokens = await tokenize("ＡＩ：＊＆｜！（ｘ）");
    expect(tokens.filter((t) => !/[\p{L}\p{N}]/u.test(t))).toEqual([]);
  });

  it("長音記号だけのトークンは残さない", async () => {
    expect(await tokenize("ーー")).toEqual([]);
    expect(await tokenize("すごーーい")).not.toContain("ーー");
  });

  it("記号だけの入力は、空の配列", async () => {
    expect(await tokenize("<->")).toEqual([]);
    expect(await tokenize("':*&|!()")).toEqual([]);
  });
});

describe("tokenizeQuery(ユーザー入力用)", () => {
  // 普通の日本語の文を並べて、上限ちょうどの長さにする
  const sentence = "仕事で失敗して、毎日眠れずに思い悩んでいます。";
  const ofLength = (n: number) => sentence.repeat(Math.ceil(n / sentence.length)).slice(0, n);

  it("上限ちょうどの長さは通る", async () => {
    const tokens = await tokenizeQuery(ofLength(MAX_QUERY_CHARS));
    expect(tokens.length).toBeGreaterThan(0);
  });

  it("上限を超えた入力は、処理を始める前に断る", async () => {
    await expect(tokenizeQuery(ofLength(MAX_QUERY_CHARS + 1))).rejects.toThrow(RangeError);
  });

  it("同じ文字を繰り返した、長い入力も断る(処理が止まらない)", async () => {
    const started = performance.now();
    await expect(tokenizeQuery("ア".repeat(50_000))).rejects.toThrow(RangeError);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("短い入力は tokenize と同じ結果(文書側と同じ関数)", async () => {
    expect(await tokenizeQuery("愛しています")).toEqual(await tokenize("愛しています"));
  });

  it("文書側の tokenize は、段落の最大の長さ(約2,700字)を断らない", async () => {
    await expect(tokenize(ofLength(3000))).resolves.toBeDefined();
  });
});
