import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { parseOsis } from "./parse-osis";

// テスト用の小さな XML。書名の宣言(div type="book")と章(chapter)を付ける
const wrap = (body: string) =>
  `<div type="book" osisID="Matt"><title type="main">マタイによる福音書</title>` +
  `<chapter osisID="Matt.6"><title type="chapter">第六章</title>${body}</chapter></div>`;

describe("parseOsis(小さな XML)", () => {
  it("同じ <p> の節を1つの段落にまとめ、id は節の範囲になる", () => {
    const xml = wrap(
      `<p><verse osisID="Matt.6.33">あ</verse><verse osisID="Matt.6.34">い</verse></p>` +
        `<p><verse osisID="Matt.6.35">う</verse></p>`,
    );
    const { paragraphs, verseCount } = parseOsis(xml);

    expect(verseCount).toBe(3);
    expect(paragraphs.map((p) => p.id)).toEqual(["Matt.6.33-34", "Matt.6.35"]);
    expect(paragraphs[0]).toMatchObject({
      book_key: "Matt",
      book_name: "マタイによる福音書",
      chapter: 6,
      verse_start: 33,
      verse_end: 34,
    });
    expect(paragraphs[0].verses).toEqual([
      { verse: 33, verse_end: 33, text: "あ" },
      { verse: 34, verse_end: 34, text: "い" },
    ]);
  });

  it("ルビ(<w gloss>)を取り除いて、漢字だけにする", () => {
    const xml = wrap(
      `<p><verse osisID="Matt.6.1">アブラハムの<w gloss="こ">子</w>であるダビデ</verse></p>`,
    );
    expect(parseOsis(xml).paragraphs[0].verses[0].text).toBe("アブラハムの子であるダビデ");
  });

  it("2節が1つにまとまった節は、verse〜verse_end の範囲で持つ", () => {
    const xml = wrap(`<p><verse osisID="Matt.6.9 Matt.6.10">まとめた本文</verse></p>`);
    const [paragraph] = parseOsis(xml).paragraphs;

    expect(paragraph.id).toBe("Matt.6.9-10");
    expect(paragraph.verse_start).toBe(9);
    expect(paragraph.verse_end).toBe(10);
    expect(paragraph.verses).toEqual([{ verse: 9, verse_end: 10, text: "まとめた本文" }]);
  });

  it("詩の形式(sID / eID)の節も読める", () => {
    const xml = wrap(
      `<lg><l><verse sID="Matt.6.1" osisID="Matt.6.1"/>一行目</l><l>二行目<verse eID="Matt.6.1"/></l></lg>`,
    );
    const [paragraph] = parseOsis(xml).paragraphs;

    expect(paragraph.id).toBe("Matt.6.1");
    expect(paragraph.verses[0].text).toBe("一行目二行目");
  });

  it("本文が空の節は数えない", () => {
    const xml = wrap(
      `<p><verse osisID="Matt.6.1">   </verse><verse osisID="Matt.6.2">本文</verse></p>`,
    );
    const { paragraphs, verseCount } = parseOsis(xml);

    expect(verseCount).toBe(1);
    expect(paragraphs[0].id).toBe("Matt.6.2");
  });

  it("章をまたぐ節は、気づけるようにエラーにする", () => {
    const xml = wrap(`<p><verse osisID="Matt.6.34 Matt.7.1">本文</verse></p>`);
    expect(() => parseOsis(xml)).toThrow("章をまたぐ");
  });

  it("節番号が連続していなければ、エラーにする", () => {
    const xml = wrap(`<p><verse osisID="Matt.6.9 Matt.6.11">本文</verse></p>`);
    expect(() => parseOsis(xml)).toThrow("連続していません");
  });
});

describe("parseOsis(実際の口語訳 XML)", () => {
  // data/jpn-kougo.osis.xml はリポジトリに入っているので、CI でも読める
  const xml = fs.readFileSync(path.join(__dirname, "..", "data", "jpn-kougo.osis.xml"), "utf-8");
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

  it("マタイ6章25-34節は1つの段落で、34節の本文が正しい", () => {
    const paragraph = paragraphs.find((p) => p.id === "Matt.6.25-34");
    expect(paragraph?.verses).toHaveLength(10);
    expect(paragraph?.verses.at(-1)?.text).toBe(
      "だから、あすのことを思いわずらうな。あすのことは、あす自身が思いわずらうであろう。一日の苦労は、その日一日だけで十分である。",
    );
  });
});
