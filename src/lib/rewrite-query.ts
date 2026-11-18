// 相談文を、口語訳聖書の言い回しの検索文に書き換える(検索の精度を上げるため)。
// 現代の言葉(心配・不安)と、口語訳の言葉(思いわずらう)は距離が遠く、ベクトル検索が外れやすい。
// ここで書き換えた短い文は、検索にだけ使う。画面には出さない(聖句は、必ず id で DB から取って表示する)。
// ユーザーの入力は繊細なので、入力も書き換えた結果も、ログに出さない。
import { chatText } from "./openrouter";
import { MAX_QUERY_CHARS } from "./tokenizer";

const SYSTEM_PROMPT = `あなたは、日本語口語訳聖書(1954/1955年版)の検索を助けるアシスタントです。
ユーザーが書いた悩みを読み、その悩みに答える聖書の箇所を、ベクトル検索で見つけるための「検索文」を作ってください。

- 悩みと同じ意味のことを、口語訳の聖書に出てくる言い回し・語彙で書いた、短い文(1文、40字以内)を3つ作る
  (例: 「心配・不安」→「思いわずらう」、「許せない」→「ゆるす」「ゆるしあう」、「疲れた」→「労する」「重荷を負う」「休ませる」、「悲しい」→「涙」「なげき」「なぐさめ」)
- 3つは、角度を変える(悩みそのものの気持ち / 悩みの原因や状況 / 神からの慰めや教え)
- 聖書の本文を、そのまま長く引用しない
- 聖書にない現代の言葉(スマホ、AI、ビットコインなど)は、聖書にある主題(富への執着、新しい技術への不安、など)に置き換える
- 出力は、検索文だけを、1行に1つ、3行で書く。番号・記号・説明は付けない`;

const MAX_REWRITES = 5;
const MAX_REWRITE_CHARS = 120;

// モデルの返答から、検索文の配列を取り出す。番号・記号・かぎ括弧は取り除く。
// 形式が崩れていても、使える行だけを拾う。1行も拾えなければ、止まる
export function parseRewrites(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        // 先頭の「1.」「1)」「-」「*」「・」などの印を除く(重なっていても、すべて除く)
        .replace(/^(?:(?:\d+[.)．、]|[-*・●○])\s*)+/, "")
        // 前後のかぎ括弧・引用符を除く
        .replace(/^[「『"“]+|[」』"”]+$/g, "")
        .trim(),
    )
    .filter((line) => line !== "" && line.length <= MAX_REWRITE_CHARS);

  const unique = [...new Set(lines)].slice(0, MAX_REWRITES);
  if (unique.length === 0) throw new Error("検索文を取り出せませんでした");
  return unique;
}

export interface RewriteResult {
  queries: string[];
  // 費用の見積もり用(本文は含まない)
  usage: { promptTokens: number | undefined; completionTokens: number | undefined };
}

export interface RewriteOptions {
  // 相談1件ぶんの全体の締め切り(OpenRouter の呼び出しと、やり直しの待ちを止める)
  signal?: AbortSignal;
}

// 相談文を、口語訳の言い回しの検索文(3つ前後)に書き換える
export async function rewriteQuery(
  consultation: string,
  options: RewriteOptions = {},
): Promise<RewriteResult> {
  if (consultation.trim() === "") throw new RangeError("相談文が空です");
  if (consultation.length > MAX_QUERY_CHARS) {
    throw new RangeError(`入力が長すぎます(${MAX_QUERY_CHARS}字まで)`);
  }

  const { text, usage } = await chatText(
    {
      system: SYSTEM_PROMPT,
      user: consultation,
      // 推論(reasoning)のトークンも、この中に数えられるので、余裕を持たせる
      maxTokens: 600,
      temperature: 0.2,
      reasoningEffort: "minimal",
    },
    options.signal ? { signal: options.signal } : {},
  );
  return { queries: parseRewrites(text), usage };
}
