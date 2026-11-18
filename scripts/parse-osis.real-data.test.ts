import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { parseOsis } from "./parse-osis";

// 実際の口語訳 XML を使うテスト。
// XML は、再配布してよいか分からないので、リポジトリに入れていない(.gitignore)。
// `npm run bible:fetch` で配布元から取得する(CI も、テストの前に同じコマンドを実行する)。
const xmlPath = path.join(__dirname, "..", "data", "jpn-kougo.osis.xml");

describe("parseOsis(実際の口語訳 XML)", () => {
  // XML が無いときは、黙って飛ばさず、はっきり失敗させる(検証した気にならないように)
  if (!fs.existsSync(xmlPath)) {
    throw new Error(
      `${xmlPath} がありません。\`npm run bible:fetch\` で配布元から取得してから実行してください`,
    );
  }
  const xml = fs.readFileSync(xmlPath, "utf-8");
  const { paragraphs, verseCount } = parseOsis(xml);
  const allVerses = paragraphs.flatMap((p) => p.verses);

  it("節と段落の件数が変わっていない(取りこぼしの検知)", () => {
    expect(verseCount).toBe(31088);
    expect(paragraphs).toHaveLength(5709);
    expect(allVerses).toHaveLength(31088);
  });

  it("66巻そろっている", () => {
    expect(new Set(paragraphs.map((p) => p.book_key)).size).toBe(66);
  });

  it("旧約39巻・新約27巻で、書の番号は 1〜66 が1つずつ", () => {
    const books = new Map(paragraphs.map((p) => [p.book_key, p]));
    const all = [...books.values()];
    expect(all.filter((p) => p.testament === "OT")).toHaveLength(39);
    expect(all.filter((p) => p.testament === "NT")).toHaveLength(27);
    expect(all.map((p) => p.book_order).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 66 }, (_, i) => i + 1),
    );
  });

  it("書の番号の端・境目・途中: 中間の書の入れ替えにも気づく", () => {
    const order = (key: string) => paragraphs.find((p) => p.book_key === key)?.book_order;
    expect(order("Gen")).toBe(1);
    expect(order("Ps")).toBe(19);
    expect(order("Prov")).toBe(20);
    expect(order("Isa")).toBe(23);
    expect(order("Mal")).toBe(39);
    expect(order("Matt")).toBe(40);
    expect(order("Rom")).toBe(45);
    expect(order("Heb")).toBe(58);
    expect(order("Rev")).toBe(66);
  });

  it("書ごとに、旧約・新約と番号が1通りに決まっている", () => {
    const seen = new Map<string, string>();
    for (const p of paragraphs) {
      const v = `${p.testament}/${p.book_order}`;
      expect(seen.get(p.book_key) ?? v).toBe(v);
      seen.set(p.book_key, v);
    }
  });

  it("段落の id は一意", () => {
    expect(new Set(paragraphs.map((p) => p.id)).size).toBe(paragraphs.length);
  });

  it("本文にタグや記号が残っていない", () => {
    expect(allVerses.filter((v) => /[<>&]/.test(v.text))).toEqual([]);
  });

  it("節番号は、段落の中で飛ばずに並ぶ(既知の例外を除く)", () => {
    // 出エジプト記22章は、口語訳の節の並びが標準と違うため、2つの段落に分かれる
    const knownExceptions = new Set(["Exod.22.1-4"]);
    const broken = paragraphs
      .filter((p) => !knownExceptions.has(p.id))
      .filter((p) => {
        let expected = p.verse_start;
        for (const v of p.verses) {
          if (v.verse !== expected) return true;
          expected = v.verse_end + 1;
        }
        return expected - 1 !== p.verse_end;
      })
      .map((p) => p.id);

    expect(broken).toEqual([]);
  });

  it("2節まとめの節は 16 件で、Rom.1.8-17 に 9-10 節がある", () => {
    expect(allVerses.filter((v) => v.verse !== v.verse_end)).toHaveLength(16);
    const rom = paragraphs.find((p) => p.id === "Rom.1.8-17");
    expect(
      rom?.verses.map((v) =>
        v.verse === v.verse_end ? `${v.verse}` : `${v.verse}-${v.verse_end}`,
      ),
    ).toEqual(["8", "9-10", "11", "12", "13", "14", "15", "16", "17"]);
  });

  it("既知の例外: 出エジプト記22章は2つの段落に分かれる", () => {
    const ids = paragraphs
      .filter((p) => p.book_key === "Exod" && p.chapter === 22)
      .map((p) => p.id);
    expect(ids).toContain("Exod.22.1-4");
    expect(ids).toContain("Exod.22.2-3");
  });

  it("マタイ6章25-34節は1つの段落で、節の数が正しい", () => {
    const paragraph = paragraphs.find((p) => p.id === "Matt.6.25-34");
    expect(paragraph?.verses).toHaveLength(10);
    expect(paragraph?.verse_start).toBe(25);
    expect(paragraph?.verse_end).toBe(34);
  });
});
