import { describe, expect, it } from "vitest";
import { parseOsis } from "./parse-osis";

// この中のテストは、自作の小さな XML だけを使う(XML の取得が要らない)。
// 実際の口語訳 XML を使うテストは、parse-osis.real-data.test.ts にある

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

  it("書名の宣言が無ければ、書の key をそのまま書名にする", () => {
    const xml = `<chapter osisID="Gen.1"><p><verse osisID="Gen.1.1">本文</verse></p></chapter>`;
    expect(parseOsis(xml).paragraphs[0]).toMatchObject({ book_key: "Gen", book_name: "Gen" });
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
