// 選ばれた3件に、同じ教えの並行記事(福音書の同じ話、詩篇の重複、列王記と歴代誌など)が入らないようにする。
// ベクトルの近さでは、見分けられない(並行記事 0.66 < 別の詩 0.70)。
// 並行記事は、口語訳の本文に、同じ言い回しが、そのまま出てくる。そこで、本文が、
// 長さ n 字以上の同じ並びを共有していたら、重複とみなす。

// 比べやすいように、空白と、句読点・かぎ括弧を除く
function normalize(text: string): string {
  return text.replace(/[\s、。「」『』・,.\-]/g, "");
}

// 2つの本文が、n 字以上の同じ並びを共有しているか
export function sharesPhrase(a: string, b: string, n = 20): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (x.length < n || y.length < n) return false;
  const shingles = new Set<string>();
  for (let i = 0; i + n <= x.length; i++) shingles.add(x.slice(i, i + n));
  for (let i = 0; i + n <= y.length; i++) {
    if (shingles.has(y.slice(i, i + n))) return true;
  }
  return false;
}

export interface TextedPassage {
  id: string;
  text: string;
}

// 並んだ順に見て、すでに選んだものと重複しない段落だけを、count 件まで選ぶ(前のものを優先する)。
// 重複を除いて count 件に満たなければ、ある分だけ返す(重複していても、0件にはしない呼び出しは、呼び出し側が決める)
export function pickDistinct<T extends TextedPassage>(
  ordered: readonly T[],
  count: number,
  n = 20,
): T[] {
  const kept: T[] = [];
  for (const passage of ordered) {
    if (kept.length >= count) break;
    if (kept.some((k) => sharesPhrase(k.text, passage.text, n))) continue;
    kept.push(passage);
  }
  return kept;
}
