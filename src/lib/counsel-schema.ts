// 画面と API で共通の、入力の上限と、API の入力・応答の形。
// **サーバー用の部品(OpenRouter・DB など)を import しない**(画面のコードに、サーバーの部品が混ざらないように)。
// 外から来るデータ(API の入力、画面が受け取る応答)は、zod で検証してから使う。
import { z } from "zod";

// 入力の上限(文字)。長いと、書き換えが主題を絞れなくなるため。画面にも「500字まで」と出す
export const MAX_INPUT_CHARS = 500;

// API の入力
export const counselRequestSchema = z.object({
  consultation: z.string().trim().min(1).max(MAX_INPUT_CHARS),
  // 命の危険の固定画面を見たうえで、「それでも相談を続ける」を選んだとき(誤検知で、人を締め出さない)
  continueAnyway: z.boolean().optional(),
});
export type CounselRequest = z.infer<typeof counselRequestSchema>;

const verseViewSchema = z.object({
  // 節の表示用の番号(例: "3"、2節まとめなら "3-4")
  label: z.string(),
  // DB の節の本文のまま(AI は、書き換えていない)
  text: z.string(),
  // AI が選んだ「意味が通じる範囲」に入っているか
  inQuote: z.boolean(),
  // その中の、核心の節か(画面で太字にする)
  core: z.boolean(),
});
export type VerseView = z.infer<typeof verseViewSchema>;

const passageViewSchema = z.object({
  // 「書名 章:節」(例: マタイによる福音書 6:19-24)
  reference: z.string(),
  // 段落の全部の節。inQuote の節を初めに見せて、残りは「全文を開く」にする
  verses: z.array(verseViewSchema),
  // 解説(AI が書いたもの。引用の直下に出す)
  commentary: z.string(),
});
export type PassageView = z.infer<typeof passageViewSchema>;

// API の応答
export const counselResponseSchema = z.discriminatedUnion("kind", [
  // 命の危険を示す入力。AI も検索も呼ばず、固定の画面(crisis-message.ts)だけを出す
  z.object({ kind: z.literal("crisis") }),
  z.object({
    kind: z.literal("ok"),
    // 聖書にない現代の話題のときの、最初の一言(なければ null)
    preface: z.string().nullable(),
    passages: z.array(passageViewSchema),
    conclusion: z.string(),
    // 命の危険を示す入力で、「それでも続ける」を選んだ結果か(画面に、相談窓口の案内を添える)
    showHelp: z.boolean(),
  }),
]);
export type CounselResponse = z.infer<typeof counselResponseSchema>;

// API のエラーの応答(種類だけ。入力や結果の中身は入れない)
// - invalid: 入力の誤り
// - rate_limit: この人の、1日の回数の上限に達した(429)
// - busy: 全体の、1日の上限に達した(503。利用が集中している)
// - limit: AI サービスの、月の上限に達した(503。今月の利用は終了)
// - failed: そのほかの失敗(500)
export const counselErrorSchema = z.object({
  error: z.enum(["invalid", "rate_limit", "busy", "limit", "failed"]),
});

// API のエラーの種類ごとに、画面に出す文(画面と、開発用の見本ページで共通。"use client" のファイルから、サーバー側が値を import しないよう、ここに置く)
export const ERROR_MESSAGES = {
  invalid: "入力を確認してください(1〜500字)。",
  rate_limit: "今日の回数の上限に達しました。明日、また、お試しください。",
  busy: "いまは、利用が集中しています。しばらくしてから、もう一度お試しください。",
  limit: "今月の利用は、終了しました。来月、また、お試しください。",
  failed: "うまくいきませんでした。もう一度、お試しください。",
} as const;
