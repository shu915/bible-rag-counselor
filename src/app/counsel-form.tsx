"use client";

// 相談の画面。見た目は Claude Design の見本(クラスだけ。構造・role・aria は変えない)。文言は、このコードが正。
// 悩みを書く → 前置き → [引用 → その直下に解説] ×3 → 結論 → 注意書き。核心の節は <strong>、段落の全文は <details>。
// ユーザーの入力と結果は、画面の状態にだけ持つ(保存しない・ログに出さない・localStorage にも入れない)。
import { useEffect, useRef, useState } from "react";
import {
  ERROR_MESSAGES,
  MAX_INPUT_CHARS,
  counselErrorSchema,
  counselResponseSchema,
  type CounselResponse,
  type VerseView,
} from "@/lib/counsel-schema";
import { CRISIS_MESSAGE } from "@/lib/crisis-message";
import { Star } from "./star";

export type Done = Extract<CounselResponse, { kind: "ok" }>;

export type View =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "crisis" }
  | { status: "done"; result: Done }
  | { status: "error"; message: string };

const CARD = "rounded-[20px] border border-line bg-surface shadow-card";
const SERIF_VERSE = "font-serif text-[clamp(17px,4.4vw,18.5px)] leading-[2.05] font-medium";

function Verses({ verses }: { verses: VerseView[] }) {
  // 核心の節があるとき、ほかの節は少し薄くして、核心を浮き上がらせる(文字の濃さは、AA の対比が残る範囲)
  const hasCore = verses.some((verse) => verse.core);
  return (
    <>
      {verses.map((verse, i) => (
        <p key={i} className={`${SERIF_VERSE} ${hasCore && !verse.core ? "text-ink/80" : ""}`}>
          <sup className="font-sans text-[13px] leading-[0] font-bold text-gold-ink">
            {verse.label}
          </sup>{" "}
          {verse.core ? <strong className="core font-extrabold">{verse.text}</strong> : verse.text}
        </p>
      ))}
    </>
  );
}

// 太字にする行は、crisis-message.ts の emphasis の印で決める
function CrisisNotice({ size }: { size: "panel" | "aside" }) {
  const text = size === "panel" ? "text-base" : "text-[15px]";
  return (
    <>
      {CRISIS_MESSAGE.map((line, i) => (
        <p key={i} className={`${text} leading-[1.95] ${line.emphasis ? "font-bold" : ""}`}>
          {line.text}
        </p>
      ))}
    </>
  );
}

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none stroke-gold-ink transition-transform duration-200 group-open:rotate-180"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function Result({ result }: { result: Done }) {
  return (
    <div className="flex flex-col gap-[clamp(44px,9vw,64px)]">
      {result.showHelp && (
        <aside
          aria-label="つらいときの案内"
          className="flex flex-col gap-2.5 rounded-2xl bg-highlight p-[clamp(20px,5vw,28px)]"
        >
          <CrisisNotice size="aside" />
        </aside>
      )}
      {result.preface && (
        <p className="px-[clamp(8px,3vw,20px)] text-center text-base leading-loose text-pretty">
          {result.preface}
        </p>
      )}
      {result.passages.map((passage, i) => {
        const quoted = passage.verses.filter((v) => v.inQuote);
        const hasMore = quoted.length < passage.verses.length;
        return (
          <article key={i} className="flex flex-col">
            <div
              className={`${CARD} flex flex-col gap-4.5 px-[clamp(20px,5vw,36px)] pt-[clamp(22px,5vw,34px)] pb-[clamp(14px,3vw,20px)]`}
            >
              <h2 className="flex items-center gap-2.5 text-sm leading-[1.6] font-bold tracking-[0.05em] text-gold-ink">
                <Star size={13} className="fill-gold" />
                <span>{passage.reference}</span>
              </h2>
              <blockquote className="mb-2 flex flex-col gap-3">
                <Verses verses={quoted.length > 0 ? quoted : passage.verses} />
              </blockquote>
              {hasMore && (
                <details className="group border-t border-line">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 pt-1.5 text-sm leading-[1.6] font-medium [&::-webkit-details-marker]:hidden">
                    この段落の全文を開く({passage.verses.length}節)
                    <Chevron />
                  </summary>
                  <blockquote className="mt-2 mb-2.5 flex flex-col gap-3">
                    <Verses verses={passage.verses} />
                  </blockquote>
                </details>
              )}
            </div>
            <div aria-hidden="true" className="ml-[clamp(26px,6vw,42px)] h-6.5 w-px bg-gold" />
            <p className="px-[clamp(8px,3vw,20px)] text-base leading-loose text-pretty">
              {passage.commentary}
            </p>
          </article>
        );
      })}
      <section
        aria-labelledby="conclusion"
        className="relative flex flex-col gap-[clamp(20px,4vw,26px)] border-y border-gold px-[clamp(8px,3vw,20px)] py-[clamp(40px,8vw,56px)]"
      >
        <div
          aria-hidden="true"
          className="absolute -top-3.25 left-1/2 flex -translate-x-1/2 bg-bg px-3.5 text-gold"
        >
          <Star size={24} className="fill-current" />
        </div>
        <h2
          id="conclusion"
          className="text-center text-[26px] leading-normal font-semibold tracking-[0.14em]"
        >
          結論
        </h2>
        <p className="text-[17px] leading-[2.1] text-pretty">{result.conclusion}</p>
      </section>
    </div>
  );
}

// initial は、開発用の見本ページ(/dev/preview)が、API を呼ばずに各状態を出すためのもの
export function CounselForm({ initial }: { initial?: { text: string; view: View } }) {
  const [text, setText] = useState(initial?.text ?? "");
  const [view, setView] = useState<View>(initial?.view ?? { status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const loading = view.status === "loading";
  const loadingRef = useRef<HTMLDivElement | null>(null);

  // 「聖書に聞く」を押したら、待ちの表示が見える位置までスクロールする(下に出ることに気づかない人がいるため)
  useEffect(() => {
    if (view.status !== "loading") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    loadingRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  }, [view.status]);

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
    <div className="flex flex-col gap-[clamp(32px,7vw,48px)]">
      {/* 結果が出たことを、読み上げの人に知らせる(画面には出ない。結果の全文は、読み上げさせない) */}
      <p role="status" className="sr-only">
        {view.status === "done" ? "相談の結果を、下に表示しました。" : ""}
      </p>
      <form
        className={`${CARD} flex flex-col gap-3.5 p-[clamp(20px,5vw,32px)]`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <label htmlFor="consultation" className="text-[15px] leading-[1.7] font-bold">
          悩み事・愚痴・弱音・懺悔などを、書いてください
        </label>
        <textarea
          id="consultation"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={MAX_INPUT_CHARS}
          rows={6}
          className="block w-full resize-none rounded-xl border border-input bg-surface px-4 py-3.5 text-base leading-[1.85] text-ink"
        />
        <p className="text-sm leading-[1.75] text-muted tabular-nums">
          {text.length} / {MAX_INPUT_CHARS}字
        </p>
        <p className="text-sm leading-[1.75] text-muted">
          送信すると、下の「ご利用にあたって」(無料であること・回数の上限・保存しないこと・送信先・免責)に、
          同意したものとみなします。
        </p>
        <button
          type="submit"
          disabled={loading || text.trim() === ""}
          className="mt-1.5 min-h-13.5 w-full cursor-pointer rounded-full bg-primary font-serif text-lg font-semibold tracking-[0.12em] text-on-primary enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-ink"
        >
          聖書に聞く
        </button>
      </form>

      {view.status === "loading" && (
        <div
          ref={loadingRef}
          role="status"
          className="flex flex-col items-center gap-5 pt-5 pb-3 text-center"
        >
          <div aria-hidden="true" className="loading-stars">
            {[0, 1, 2].map((i) => (
              <Star key={i} size={24} className="fill-current" />
            ))}
          </div>
          <p className="font-serif text-base leading-[1.9] font-medium">
            聖書の言葉を探しています(20秒ほどかかります)…
          </p>
        </div>
      )}
      {view.status === "error" && (
        <p
          role="alert"
          className="flex items-start gap-3 rounded-[14px] bg-highlight px-4.5 py-4 text-[15px] leading-[1.8] font-medium"
        >
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            className="mt-1 flex-none stroke-gold-ink"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 7.5v.01" />
          </svg>
          <span>{view.message}</span>
        </p>
      )}
      {view.status === "crisis" && (
        <section
          role="alert"
          aria-label="つらいときの案内"
          className={`${CARD} flex flex-col gap-3.5 p-[clamp(24px,6vw,40px)]`}
        >
          <CrisisNotice size="panel" />
          <button
            type="button"
            onClick={() => void submit(true)}
            className="mt-3 min-h-13 w-full cursor-pointer rounded-full border border-primary bg-transparent px-5 py-2.5 text-[15px] leading-[1.6] font-bold text-primary hover:bg-highlight"
          >
            それでも、聖書の言葉を聞いてみる
          </button>
        </section>
      )}
      {view.status === "done" && <Result result={view.result} />}
    </div>
  );
}
