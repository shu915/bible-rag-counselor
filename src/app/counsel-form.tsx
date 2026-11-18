"use client";

// 相談の画面(裸の状態)。**飾りなし**: 意味のある HTML の構造だけで、見た目は、後で Claude Design に作ってもらう。
// 悩みを書く → 前置き → [引用 → その直下に解説] ×3 → 結論 → 注意書き。核心の節は <strong>、段落の全文は <details>。
// ユーザーの入力と結果は、画面の状態にだけ持つ(保存しない・ログに出さない・localStorage にも入れない)。
import { useRef, useState } from "react";
import {
  MAX_INPUT_CHARS,
  counselErrorSchema,
  counselResponseSchema,
  type CounselResponse,
  type VerseView,
} from "@/lib/counsel-schema";
import { CRISIS_MESSAGE_LINES } from "@/lib/crisis-message";

type Done = Extract<CounselResponse, { kind: "ok" }>;

type View =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "crisis" }
  | { status: "done"; result: Done }
  | { status: "error"; message: string };

const ERROR_MESSAGES = {
  invalid: "入力を確認してください(1〜500字)。",
  rate_limit: "今日の回数の上限に達しました。明日、また、お試しください。",
  busy: "いまは、利用が集中しています。しばらくしてから、もう一度お試しください。",
  limit: "今月の利用は、終了しました。来月、また、お試しください。",
  failed: "うまくいきませんでした。もう一度、お試しください。",
} as const;

function Verses({ verses }: { verses: VerseView[] }) {
  return (
    <>
      {verses.map((verse, i) => (
        <p key={i}>
          <sup>{verse.label}</sup> {verse.core ? <strong>{verse.text}</strong> : verse.text}
        </p>
      ))}
    </>
  );
}

function CrisisNotice() {
  return (
    <>
      {CRISIS_MESSAGE_LINES.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
    </>
  );
}

function Result({ result }: { result: Done }) {
  return (
    <div>
      {result.showHelp && (
        <aside aria-label="つらいときの案内">
          <CrisisNotice />
        </aside>
      )}
      {result.preface && <p>{result.preface}</p>}
      {result.passages.map((passage, i) => {
        const quoted = passage.verses.filter((v) => v.inQuote);
        const hasMore = quoted.length < passage.verses.length;
        return (
          <article key={i}>
            <h2>{passage.reference}</h2>
            <blockquote>
              <Verses verses={quoted.length > 0 ? quoted : passage.verses} />
            </blockquote>
            {hasMore && (
              <details>
                <summary>この段落の全文を開く({passage.verses.length}節)</summary>
                <blockquote>
                  <Verses verses={passage.verses} />
                </blockquote>
              </details>
            )}
            <p>{passage.commentary}</p>
          </article>
        );
      })}
      <section aria-labelledby="conclusion">
        <h2 id="conclusion">結論</h2>
        <p>{result.conclusion}</p>
      </section>
    </div>
  );
}

export function CounselForm() {
  const [text, setText] = useState("");
  const [view, setView] = useState<View>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const loading = view.status === "loading";

  async function submit(continueAnyway: boolean) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setView({ status: "loading" });
    try {
      const response = await fetch("/api/counsel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consultation: text, continueAnyway }),
        signal: abort.signal,
      });
      const json: unknown = await response.json();
      if (!response.ok) {
        const error = counselErrorSchema.safeParse(json);
        setView({
          status: "error",
          message: ERROR_MESSAGES[error.success ? error.data.error : "failed"],
        });
        return;
      }
      const parsed = counselResponseSchema.safeParse(json);
      if (!parsed.success) {
        setView({ status: "error", message: ERROR_MESSAGES.failed });
        return;
      }
      setView(
        parsed.data.kind === "crisis"
          ? { status: "crisis" }
          : { status: "done", result: parsed.data },
      );
    } catch {
      // 自分で中断したとき(新しい相談を始めた)は、何もしない
      if (!abort.signal.aborted) setView({ status: "error", message: ERROR_MESSAGES.failed });
    }
  }

  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <label htmlFor="consultation">悩み事・愚痴・弱音・懺悔を、書いてください</label>
        <textarea
          id="consultation"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={MAX_INPUT_CHARS}
          rows={6}
        />
        <p>
          {text.length} / {MAX_INPUT_CHARS}字。書いた内容と、返答は、保存されません。
        </p>
        <p>
          送信すると、下の「ご利用にあたって」(無料であること・回数の上限・保存しないこと・送信先・免責)に、
          同意したものとみなします。
        </p>
        <button type="submit" disabled={loading || text.trim() === ""}>
          聖書に聞く
        </button>
      </form>

      {view.status === "loading" && (
        <p role="status">聖書の言葉を探しています(20秒ほどかかります)…</p>
      )}
      {view.status === "error" && <p role="alert">{view.message}</p>}
      {view.status === "crisis" && (
        <section aria-label="つらいときの案内">
          <CrisisNotice />
          <button type="button" onClick={() => void submit(true)}>
            それでも、聖書の言葉を聞いてみる
          </button>
        </section>
      )}
      {view.status === "done" && <Result result={view.result} />}
    </div>
  );
}
