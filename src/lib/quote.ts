// 画面に出す引用を、段落の全部ではなく、意味のまとまりを保った、短い範囲にする。
// 長い段落(詩篇・箴言は、20〜35節)を全部出すと、読む量の大半が引用になり、読まれずに飛ばされる。
// 範囲は、AI が「節の番号」だけで選ぶ(generate-counsel)。**本文は、必ず DB の節から取る**
// (AI に、本文を書かせない)。1節だけだと、意味が通じないことがある(箴言 26:4-5 のように、2節で1つの教え)ので、
// 範囲は、AI に任せつつ、長すぎる範囲は、コードで切る。

export interface Verse {
  verse: number;
  verse_end: number;
  text: string;
}

export interface QuoteRange {
  from: number;
  to: number;
}

export interface Quote {
  // 実際に引用した、節の範囲(DB の節の番号。2節まとめの節は、その両方を含む)
  from: number;
  to: number;
  // 引用の本文(DB の節をつないだもの)
  text: string;
  // 引用した節(DB のまま)。画面で、核心の節を太字にするために、節ごとに持つ
  verses: Verse[];
  // 太字にする、核心の節の範囲(引用した節の範囲に収まるときだけ。なければ undefined)
  core?: QuoteRange;
  // 段落の一部だけを引用しているか(true なら、「この段落は 〜節まであります」と示す)
  partial: boolean;
}

// 範囲を指定しないとき・範囲が使えないときの、引用の長さの目安(字)。
// 短すぎると意味が通じず、長すぎると読まれない。「意味が分かる範囲」を出して、核心を太字にする
const DEFAULT_MAX_CHARS = 350;
// AI が選んだ範囲を、そのまま受け入れる上限(字と節の数)。これを超えたら、**核心の節を中心にして**、前後を削る。
// (AI は、プロンプトの目安(300〜450字・2〜8節)を、守らないことがある。15節の引用が出た実例がある。コードで、上限をかける)
const MAX_CHOSEN_CHARS = 450;
const MAX_CHOSEN_VERSES = 8;

const join = (verses: readonly Verse[]): string => verses.map((v) => v.text).join("");

// 節が多すぎる・長すぎるとき、核心の節(なければ、先頭)を残して、遠いほうの端から、1節ずつ削る。
// 核心の節自体が長いときは、それ以上は削らない(核心は、必ず残す)
function shrinkAround(chosen: readonly Verse[], core: QuoteRange | undefined): Verse[] {
  // 核心に重なる節の、最初と最後の位置(核心がなければ、先頭の1節)
  const coreFirst = core ? chosen.findIndex((v) => v.verse_end >= core.from) : 0;
  const coreLast = core ? chosen.findLastIndex((v) => v.verse <= core.to) : 0;
  const ci0 = Math.max(coreFirst, 0);
  const ci1 = Math.max(coreLast, ci0);

  let start = 0;
  let end = chosen.length - 1;
  const tooBig = (): boolean =>
    end - start + 1 > MAX_CHOSEN_VERSES ||
    join(chosen.slice(start, end + 1)).length > MAX_CHOSEN_CHARS;
  while (end > start && tooBig()) {
    const canTrimEnd = end > ci1;
    const canTrimStart = start < ci0;
    if (!canTrimEnd && !canTrimStart) break;
    // 核心から遠いほうを削る(同じなら、後ろ)
    if (canTrimEnd && (!canTrimStart || end - ci1 >= ci0 - start)) end -= 1;
    else start += 1;
  }
  return chosen.slice(start, end + 1);
}

// AI が返した範囲が、段落の節の範囲に収まる、整数の組か
export function isValidRange(
  range: { from?: number | null; to?: number | null },
  verses: readonly Verse[],
): range is QuoteRange {
  const { from, to } = range;
  if (typeof from !== "number" || typeof to !== "number") return false;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return false;
  const first = verses[0]?.verse;
  const last = verses[verses.length - 1]?.verse_end;
  return first !== undefined && last !== undefined && from >= first && to <= last;
}

// AI の返答の値(unknown)から、使える範囲だけを取り出す。型が違う・範囲外なら undefined
// (範囲の誤りだけを捨てて、解説は使えるようにする)
export function toQuoteRange(
  from: unknown,
  to: unknown,
  verses: readonly Verse[],
): QuoteRange | undefined {
  if (typeof from !== "number" || typeof to !== "number") return undefined;
  const range = { from, to };
  return isValidRange(range, verses) ? range : undefined;
}

// 段落の節と、(あれば)AI が選んだ範囲から、引用を作る。
// - 範囲が正しければ、その範囲の節(長すぎれば、後ろの節から、1節は残るまで削る)
// - 範囲がなければ、段落の先頭から、DEFAULT_MAX_CHARS 字を超えるまでの節
// - core(太字にする核心の節)は、引用した節の範囲に収まるときだけ残す
// avoid を指定すると、その言葉を含む節を、引用から外す(命の危険を示す入力のとき。crisis.ts の LIFE_LOSS_WORDS)。
// 核心の節を中心に、その言葉を含まない、つながった範囲に絞る。核心の節が、その言葉を含むときは、最も近い、含まない節から始める。
// 範囲のすべての節が含むときは、外せないので、そのまま(呼び出し側が、AI の指示でも、避けるようにしている)
export interface BuildQuoteOptions {
  avoid?: RegExp;
}

// chosen のうち、avoid を含まない、つながった範囲(核心に最も近いもの)だけを残す
function avoidVerses(chosen: Verse[], core: QuoteRange | undefined, avoid: RegExp): Verse[] {
  const bad = chosen.map((v) => avoid.test(v.text));
  if (!bad.some(Boolean) || bad.every(Boolean)) return chosen;
  // 核心の位置(なければ、先頭)
  const coreIdx = core
    ? chosen.findIndex((v) => v.verse_end >= core.from && v.verse <= core.to)
    : 0;
  const from = Math.max(coreIdx, 0);
  // 核心に最も近い、含まない節(同じ距離なら、後ろ)
  let anchor = -1;
  for (let d = 0; d < chosen.length && anchor === -1; d++) {
    if (from + d < chosen.length && !bad[from + d]) anchor = from + d;
    else if (from - d >= 0 && !bad[from - d]) anchor = from - d;
  }
  let start = anchor;
  let end = anchor;
  while (start > 0 && !bad[start - 1]) start -= 1;
  while (end < chosen.length - 1 && !bad[end + 1]) end += 1;
  return chosen.slice(start, end + 1);
}

export function buildQuote(
  verses: readonly Verse[],
  range?: QuoteRange,
  core?: QuoteRange,
  options: BuildQuoteOptions = {},
): Quote {
  if (verses.length === 0) return { from: 0, to: 0, text: "", verses: [], partial: false };

  let chosen: Verse[];
  if (range && isValidRange(range, verses)) {
    // 範囲に重なる節(2節まとめの節も含む)
    const inRange = verses.filter((v) => v.verse_end >= range.from && v.verse <= range.to);
    const coreInRange = core ? toQuoteRange(core.from, core.to, inRange) : undefined;
    chosen = shrinkAround(inRange, coreInRange);
  } else {
    chosen = [];
    for (const v of verses) {
      chosen.push(v);
      if (join(chosen).length >= DEFAULT_MAX_CHARS) break;
    }
  }

  if (options.avoid) chosen = avoidVerses(chosen, core, options.avoid);

  const first = chosen[0] ?? verses[0];
  const last = chosen[chosen.length - 1] ?? verses[verses.length - 1];
  const validCore = core ? toQuoteRange(core.from, core.to, chosen) : undefined;
  return {
    from: first?.verse ?? 0,
    to: last?.verse_end ?? 0,
    text: join(chosen),
    verses: chosen,
    ...(validCore ? { core: validCore } : {}),
    partial: chosen.length < verses.length,
  };
}
