import { ERROR_MESSAGES } from "@/lib/counsel-schema";
import type { View } from "../../counsel-form";

// 開発用の見本。聖句は入れない(本文は再配布の扱いが未確認なので、見本の文にする)
const verse = (label: string, text: string, inQuote: boolean, core = false) => ({
  label,
  text,
  inQuote,
  core,
});

const SAMPLE_TEXT =
  "SNSを開くたびに、同世代の活躍が目に入って、自分だけ取り残されている気がします。";

const result = (showHelp: boolean): View => ({
  status: "done",
  result: {
    kind: "ok",
    preface:
      "(見本の前置き)それは聖書には載っていませんが、人と比べて苦しくなる気持ちは、書き残されています。",
    passages: [
      {
        reference: "見本の書 1:1",
        verses: [verse("1", "(見本の聖句です。実際の本文は、API から来ます。)", true, true)],
        commentary: "(見本の解説)引用のすぐ下に、相談に絡めた解説が入ります。".repeat(3),
      },
      {
        reference: "見本の書 2:1-5",
        verses: [
          verse("1", "(見本の聖句。引用の外の節です。)", false),
          verse("2", "(見本の聖句。引用の中の節です。)".repeat(2), true),
          verse("3", "(見本の聖句。核心の節は太字になります。)".repeat(3), true, true),
          verse("4", "(見本の聖句。引用の外の節です。)", false),
          verse("5", "(見本の聖句。引用の外の節です。)", false),
        ],
        commentary: "(見本の解説)".repeat(30),
      },
      {
        reference: "見本の書 3:1-2",
        verses: [verse("1", "(見本の聖句)", true), verse("2", "(見本の聖句)", true, true)],
        commentary: "(見本の解説)".repeat(20),
      },
    ],
    conclusion: "(見本の結論)全体をまとめた結論が入ります。".repeat(8),
    showHelp,
  },
});

export const PREVIEW_STATES: Record<string, { text: string; view: View }> = {
  idle: { text: "", view: { status: "idle" } },
  loading: { text: SAMPLE_TEXT, view: { status: "loading" } },
  result: { text: SAMPLE_TEXT, view: result(false) },
  "result-help": { text: SAMPLE_TEXT, view: result(true) },
  crisis: { text: "祖母が死にそうだと聞いて、何も手につきません。", view: { status: "crisis" } },
  "error-invalid": {
    text: SAMPLE_TEXT,
    view: { status: "error", message: ERROR_MESSAGES.invalid },
  },
  "error-rate-limit": {
    text: SAMPLE_TEXT,
    view: { status: "error", message: ERROR_MESSAGES.rate_limit },
  },
  "error-busy": { text: SAMPLE_TEXT, view: { status: "error", message: ERROR_MESSAGES.busy } },
  "error-limit": { text: SAMPLE_TEXT, view: { status: "error", message: ERROR_MESSAGES.limit } },
  "error-failed": { text: SAMPLE_TEXT, view: { status: "error", message: ERROR_MESSAGES.failed } },
};
