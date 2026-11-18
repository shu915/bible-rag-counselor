// 検索の評価(eval-search.ts)の、通信や DB を使わない部分。
import { z } from "zod";

// eval/search-eval.json。外から来るデータなので、読み込んだら検証する
export const evalFileSchema = z.object({
  description: z.string(),
  status: z.enum(["draft", "reviewed"]),
  cases: z
    .array(
      z.object({
        id: z.string().min(1),
        query: z.string().min(1),
        // どれか1つが上位に出れば成功
        expected: z.array(z.string().min(1)).min(1),
        note: z.string().optional(),
        tags: z.array(z.string()).optional(),
        // dev: 方法の調整に使う / holdout: 調整には使わない、確認用(調整のしすぎで、例題だけに合うのを防ぐ)
        split: z.enum(["dev", "holdout"]).optional(),
        // false の間は、人の確認が済んでいない下書き
        reviewed: z.boolean().optional(),
      }),
    )
    .min(1),
});
export type EvalCase = z.infer<typeof evalFileSchema>["cases"][number];

// 検索結果(順位つきの id の並び)のうち、正解のどれかが最初に現れる順位(1から数える)。無ければ undefined
export function firstRank(
  ranked: readonly string[],
  expected: readonly string[],
): number | undefined {
  const index = ranked.findIndex((id) => expected.includes(id));
  return index === -1 ? undefined : index + 1;
}

export interface Summary {
  count: number;
  hitAt1: number; // 1位に正解が出た割合
  hitAt3: number; // 上位3件に正解が入った割合(アプリが実際に見せる件数)
  hitAt10: number; // 上位10件(LLM に選ばせる候補にする場合の目安)
  hitAt15: number;
  hitAt20: number;
  hitAt30: number;
  mrr: number; // 平均逆順位(1位なら1、2位なら0.5、…、圏外なら0)
}

export function summarize(ranks: readonly (number | undefined)[]): Summary {
  const count = ranks.length;
  const within = (k: number): number =>
    count === 0 ? 0 : ranks.filter((r) => r !== undefined && r <= k).length / count;
  const mrr =
    count === 0
      ? 0
      : ranks.reduce<number>((sum, r) => sum + (r === undefined ? 0 : 1 / r), 0) / count;
  return {
    count,
    hitAt1: within(1),
    hitAt3: within(3),
    hitAt10: within(10),
    hitAt15: within(15),
    hitAt20: within(20),
    hitAt30: within(30),
    mrr,
  };
}

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
