// 複数の順位つきリストを、RRF(Reciprocal Rank Fusion)で1つにまとめる。
// 各リストでの順位 r に 1/(k+r) の点を与えて、合計の高い順に並べる。k は、上位の差を和らげる定数(慣例で60)
export function rrfFuse(lists: readonly (readonly string[])[], k = 60): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  // 同点は、先に現れたもの(Map は挿入順を保つ)を先にする
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
