// 聖書66巻の、OSIS の書キーと並び順の表。
// 元の XML は新約が先に並んでいるので、出現順は使えない。ここが「聖書の順」の唯一の出どころ。
// 並びはプロテスタントの標準(創世記が1、黙示録が66。旧約39巻・新約27巻)。

export type Testament = "OT" | "NT";

// 旧約39巻(この順に 1〜39)
const OLD_TESTAMENT = [
  "Gen",
  "Exod",
  "Lev",
  "Num",
  "Deut",
  "Josh",
  "Judg",
  "Ruth",
  "1Sam",
  "2Sam",
  "1Kgs",
  "2Kgs",
  "1Chr",
  "2Chr",
  "Ezra",
  "Neh",
  "Esth",
  "Job",
  "Ps",
  "Prov",
  "Eccl",
  "Song",
  "Isa",
  "Jer",
  "Lam",
  "Ezek",
  "Dan",
  "Hos",
  "Joel",
  "Amos",
  "Obad",
  "Jonah",
  "Mic",
  "Nah",
  "Hab",
  "Zeph",
  "Hag",
  "Zech",
  "Mal",
] as const;

// 新約27巻(この順に 40〜66)
const NEW_TESTAMENT = [
  "Matt",
  "Mark",
  "Luke",
  "John",
  "Acts",
  "Rom",
  "1Cor",
  "2Cor",
  "Gal",
  "Eph",
  "Phil",
  "Col",
  "1Thess",
  "2Thess",
  "1Tim",
  "2Tim",
  "Titus",
  "Phlm",
  "Heb",
  "Jas",
  "1Pet",
  "2Pet",
  "1John",
  "2John",
  "3John",
  "Jude",
  "Rev",
] as const;

const BOOKS = new Map<string, { testament: Testament; order: number }>();
OLD_TESTAMENT.forEach((key, i) => BOOKS.set(key, { testament: "OT", order: i + 1 }));
NEW_TESTAMENT.forEach((key, i) =>
  BOOKS.set(key, { testament: "NT", order: OLD_TESTAMENT.length + i + 1 }),
);

// 表にない書キーは、黙って通さず止める(対応表の抜けに気づけるように)
export function bookInfo(bookKey: string): { testament: Testament; order: number } {
  const info = BOOKS.get(bookKey);
  if (!info) throw new Error(`未知の書キーです: ${bookKey}`);
  return info;
}
