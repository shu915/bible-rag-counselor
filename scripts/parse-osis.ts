// OSIS 形式の聖書 XML を、段落ごとの JSON(検索の単位)に変換する。
// ファイルの読み書きはしない純粋な関数(テストしやすいように、convert-osis.ts から分けてある)。

// 出力する1段落分のデータ。検索(ベクトル化・全文検索)の単位は段落。
// 検索用の本文は verses を結合して DB 投入時に作る(元データは verses の1か所だけ)。
export interface BibleParagraph {
  id: string; // 例: "Matt.6.25-34"（1節だけなら "Matt.1.1"）。引用の出典としてそのまま確認できる
  book_key: string; // 例: "Matt"
  book_name: string; // 例: "マタイによる福音書"
  chapter: number; // 例: 6
  verse_start: number; // 例: 25
  verse_end: number; // 例: 34
  // 含まれる節（引用の節番号表示用）。
  // 元データには2節が1つにまとまったもの（例: Rom.1.9 Rom.1.10）があるため、
  // 節番号は verse〜verse_end の範囲で持つ（通常は verse === verse_end）。
  verses: { verse: number; verse_end: number; text: string }[];
}

interface ParsedVerse {
  bookKey: string;
  chapter: number;
  verse: number;
  verseEnd: number;
  text: string;
  boundary: number; // 所属段落の境界位置（同じ値の節は同じ段落）
}

export interface ParseResult {
  paragraphs: BibleParagraph[];
  verseCount: number;
}

export function parseOsis(xmlContent: string): ParseResult {
  // XML内の <div type="book" osisID="Matt"><title type="main">書名</title> から書名を取得
  const bookNames: Record<string, string> = {};
  const bookRegex = /<div type="book" osisID="([^"]+)">\s*<title type="main">([^<]+)<\/title>/g;
  let bookMatch: RegExpExecArray | null;
  while ((bookMatch = bookRegex.exec(xmlContent)) !== null) {
    bookNames[bookMatch[1]] = bookMatch[2].trim();
  }

  // 2種類の節表記に対応:
  //  (A) <verse osisID="X">...</verse>
  //  (B) <verse sID="X" osisID="X"/>...<verse eID="X"/>  （段落や詩をまたぐ節）
  const verseRegex =
    /<verse\s+osisID="([^"]+)">([\s\S]*?)<\/verse>|<verse\s+sID="([^"]+)"\s+osisID="[^"]+"\s*\/>([\s\S]*?)<verse\s+eID="\3"\s*\/>/g;

  // 段落の境界位置: 章の開始 / <p> / <lg>（詩の連）。
  // 節の開始位置より前で最も近い境界を、その節の所属段落とする。
  const boundaries: number[] = [];
  const boundaryRegex = /<chapter\s|<p>|<p\s|<lg>|<lg\s/g;
  let bMatch: RegExpExecArray | null;
  while ((bMatch = boundaryRegex.exec(xmlContent)) !== null) {
    boundaries.push(bMatch.index);
  }
  const findBoundary = (pos: number): number => {
    let lo = 0;
    let hi = boundaries.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (boundaries[mid] <= pos) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return boundaries[ans] ?? -1;
  };

  // 1. 全節を抽出
  const verses: ParsedVerse[] = [];
  let match: RegExpExecArray | null;
  while ((match = verseRegex.exec(xmlContent)) !== null) {
    const osisId = match[1] ?? match[3]; // 例: "Matt.6.34" / 2節まとめなら "Rom.1.9 Rom.1.10"
    const rawContent = match[2] ?? match[4]; // ルビタグなどが含まれる生テキスト

    const refs = osisId
      .trim()
      .split(/\s+/)
      .map((r) => r.split("."));
    if (refs.some((r) => r.length < 3)) continue;
    const [bookKey, chapterStr, verseStr] = refs[0];
    const lastRef = refs[refs.length - 1];

    // 複数節にまたがる場合は、同じ章内で連続していることを前提とし、崩れていたら気づけるよう止める
    if (lastRef[0] !== bookKey || lastRef[1] !== chapterStr) {
      throw new Error(`章をまたぐ節は未対応です: ${osisId}`);
    }
    for (let i = 1; i < refs.length; i++) {
      if (parseInt(refs[i][2], 10) !== parseInt(refs[i - 1][2], 10) + 1) {
        throw new Error(`節番号が連続していません: ${osisId}`);
      }
    }

    // ルビ記号 <w gloss="...">子</w> を中身の漢字だけにし、残りのタグ・空白を整形
    const text = rawContent
      .replace(/<w[^>]*>(.*?)<\/w>/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;

    verses.push({
      bookKey,
      chapter: parseInt(chapterStr, 10),
      verse: parseInt(verseStr, 10),
      verseEnd: parseInt(lastRef[2], 10),
      text,
      boundary: findBoundary(match.index),
    });
  }

  // 2. 段落ごとに節をまとめる（Map は挿入順を保つので聖書の順序のまま）
  const groups = new Map<string, ParsedVerse[]>();
  for (const v of verses) {
    const key = `${v.bookKey}.${v.chapter}@${v.boundary}`;
    const list = groups.get(key);
    if (list) list.push(v);
    else groups.set(key, [v]);
  }

  const paragraphs: BibleParagraph[] = [];
  const seenIds = new Set<string>();
  for (const group of groups.values()) {
    const first = group[0];
    const last = group[group.length - 1];
    const range =
      first.verse === last.verseEnd ? `${first.verse}` : `${first.verse}-${last.verseEnd}`;
    const id = `${first.bookKey}.${first.chapter}.${range}`;

    // ID は引用の出典として一意でなければならない
    if (seenIds.has(id)) throw new Error(`段落IDが重複しています: ${id}`);
    seenIds.add(id);

    paragraphs.push({
      id,
      book_key: first.bookKey,
      book_name: bookNames[first.bookKey] ?? first.bookKey,
      chapter: first.chapter,
      verse_start: first.verse,
      verse_end: last.verseEnd,
      verses: group.map((v) => ({ verse: v.verse, verse_end: v.verseEnd, text: v.text })),
    });
  }

  return { paragraphs, verseCount: verses.length };
}
