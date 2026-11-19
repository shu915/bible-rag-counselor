"use client";

// 昼夜の切り替えボタン。初期値は OS の設定。押すと、html の data-theme を上書きし、「light」か「dark」だけを
// localStorage に保存する(相談の内容は、入れない。保存できない環境でも、動く)。
// 読み込みのちらつきは、layout.tsx の小さな script が、保存した値を、先に反映して防ぐ。
import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "theme";
const CHANGE_EVENT = "themechange";

function currentTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  window.addEventListener(CHANGE_EVENT, onChange);
  media.addEventListener("change", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    media.removeEventListener("change", onChange);
  };
}

export function ThemeToggle() {
  // サーバーでは「light」として描き、ブラウザで、実際の値に更新される(ずれの警告は出ない)
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as const);
  const next: Theme = theme === "dark" ? "light" : "dark";

  function toggle() {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 保存できなくても、この画面の間は、切り替わる
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={next === "dark" ? "ダークモードにする" : "ライトモードにする"}
      className="absolute top-4 right-4 flex size-11 cursor-pointer items-center justify-center rounded-full border-[1.5px] border-gold bg-surface text-gold-ink shadow-card hover:border-primary hover:text-primary"
    >
      {theme === "dark" ? (
        // 夜のとき: 太陽(押すと、昼になる)
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        // 昼のとき: 月(押すと、夜になる)
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
