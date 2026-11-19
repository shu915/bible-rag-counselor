// 解説が、画面に出ていない節の言葉を、「」で引いていないかを確かめる。
// 引用の範囲は、AI が選んだあと、コードが上限(8節・約450字)で切ることがある。切られた節の言葉を、解説が引くと、
// 読む人は「全文を開く」を押さないと、その言葉に出会えない。そこで、画面に出る節にはなく、出ない節にある言葉を引いた文を、落とす。
// AI は、引用符の中で、語尾を変える(「あります」を「ある」に)ことがよくある。完全一致では、そこを通してしまうので、
// 4文字ずつの重なり(似ているか)で比べる。
// 入力も結果も、ログに出さない。

// 比べるための正規化: 全角・半角をそろえ、空白と、区切りの記号(、。「」・)を除く
function normalize(text: string): string {
  return text.normalize("NFKC").replace(/[\s、。,.「」『』・()]/g, "");
}

// 「」の中の語句が、短すぎると、偶然の一致(「主は」「神の」など)で、誤って落とす。これ未満は、調べない
// (実際に、「空である」のような4字の引用が、範囲の外から来た)
const MIN_QUOTED_CHARS = 4;
// 重なりを数える、文字の長さ
const SHINGLE = 4;
// 出ない節に、引用の4文字の並びが、これ以上の割合で含まれ、出る節より多いとき、「出ない節の言葉」と見なす
const HIDDEN_RATIO = 0.7;

// 文字列を、4文字ずつ(1文字ずらしで)区切る
function shingles(text: string): string[] {
  const result: string[] = [];
  for (let i = 0; i + SHINGLE <= text.length; i++) result.push(text.slice(i, i + SHINGLE));
  return result;
}

// phrase の4文字の並びのうち、source に含まれる割合
function overlapRatio(phrase: string, source: string): number {
  const parts = shingles(phrase);
  if (parts.length === 0) return 0;
  return parts.filter((part) => source.includes(part)).length / parts.length;
}

// 「」の外の「。」で、文に分ける(「」の中の「。」では分けない。区切りの「。」は、文に残す)
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    current += ch;
    if (ch === "「") depth++;
    else if (ch === "」") depth = Math.max(0, depth - 1);
    else if (ch === "。" && depth === 0) {
      sentences.push(current);
      current = "";
    }
  }
  if (current !== "") sentences.push(current);
  return sentences;
}

function quotedPhrases(sentence: string): string[] {
  return [...sentence.matchAll(/「([^「」]+)」/g)].map((m) => normalize(m[1] ?? ""));
}

// shown: 画面に出る節の本文(つないだもの)。hidden: 同じ段落の、画面に出ない節の本文(つないだもの)
export function dropUnseenQuotes(commentary: string, shown: string, hidden: string): string {
  const shownNorm = normalize(shown);
  const hiddenNorm = normalize(hidden);
  // 出ない節がない、または、出る節が1つもない(画面は全文を出す)ときは、調べない
  if (hiddenNorm === "" || shownNorm === "") return commentary;

  const kept = splitSentences(commentary).filter((sentence) =>
    quotedPhrases(sentence).every((phrase) => {
      if (phrase.length < MIN_QUOTED_CHARS) return true;
      const inHidden = overlapRatio(phrase, hiddenNorm);
      const inShown = overlapRatio(phrase, shownNorm);
      return !(inHidden >= HIDDEN_RATIO && inHidden > inShown);
    }),
  );
  // すべて落ちるなら、元のまま(空の解説にしない)
  return kept.length === 0 ? commentary : kept.join("");
}
