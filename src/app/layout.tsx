import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// 全画面の書体は、Shippori Mincho(SIL OFL。src/app/fonts/OFL.txt)。自分で持つ:
// next/font/google の日本語フォントは、next dev(Turbopack)が「Module not found: @vercel/turbopack-next/internal/font/google/font」で落ちる(build は通る)ため。
// 使う字だけに削った woff2(基本 + JIS 第一水準 + 聖書の本文に出る全文字 + 画面の文言。3,633字)を、500・600・800 の3つ置く。
// 含まない字は、OS の明朝で代わる。先読みはしない(合計 約 1.9MB。初回だけ読み込み、あとはキャッシュされる)。
// 作り直すとき: 元の TTF(google/fonts の ofl/shipporimincho)を、pyftsubset で同じ字に削る
const shipporiMincho = localFont({
  variable: "--font-shippori-mincho",
  display: "swap",
  preload: false,
  src: [
    { path: "./fonts/ShipporiMincho-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ShipporiMincho-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "./fonts/ShipporiMincho-ExtraBold.woff2", weight: "800", style: "normal" },
  ],
});

export const metadata: Metadata = {
  title: "聖書カウンセラー",
  description: "悩みや弱音、懺悔を打ち明けると、聖書の言葉を引きながら答えてくれます。",
  // 検索エンジンに載せない(next.config.ts のヘッダーと、二重にしてある)。広く公開するときに外す
  robots: { index: false, follow: false },
};

// 保存した昼夜の設定を、描画の前に反映する(ちらつき防止)。保存できない環境でも、止まらない
const THEME_SCRIPT = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

// ホーム画面や、ブラウザの上端の色。昼夜で分ける(ダークのとき、上端が明るいままにならない)
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf7f0" },
    { media: "(prefers-color-scheme: dark)", color: "#12161f" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme は、script が描画の前に付けるので、サーバーの HTML とずれる(警告を出さない)
    <html
      lang="ja"
      className={`${shipporiMincho.variable} h-full font-sans antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
