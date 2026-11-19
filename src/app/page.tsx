import { CounselForm } from "./counsel-form";
import { Notices } from "./notices";
import { Star } from "./star";
import { ThemeToggle } from "./theme-toggle";

// 相談の画面。見た目は Claude Design の見本(アーチ・金・明朝)。文言とロジックは、このコードが正
export default function Home() {
  return (
    <main className="relative mx-auto flex w-full max-w-180 flex-col gap-[clamp(32px,7vw,48px)] px-6 pt-[clamp(24px,6vw,56px)] pb-[clamp(56px,10vw,96px)]">
      <header className="relative mx-auto flex w-full max-w-140 flex-col items-center gap-4.5 px-7 pt-[clamp(84px,17vw,112px)] pb-11 text-center">
        <div
          aria-hidden="true"
          className="fade-bottom absolute inset-0 rounded-t-[280px] border border-b-0 border-gold bg-[radial-gradient(ellipse_72%_58%_at_50%_20%,var(--glow),transparent_76%)]"
        />
        <div
          aria-hidden="true"
          className="fade-bottom absolute inset-x-3 top-3 bottom-0 rounded-t-[268px] border border-b-0 border-line"
        />
        <div className="relative flex flex-col items-center gap-4.5">
          <Star size={22} className="fill-gold" />
          <h1 className="font-serif text-[clamp(26px,7vw,42px)] leading-[1.45] font-semibold tracking-[0.04em] break-keep">
            聖書に、聞いてみる。
          </h1>
          {/* 文ごとに塊にして、文の切れ目でだけ折る。狭い幅で1文が長いときは、文節で折る */}
          <p className="font-serif text-[clamp(15px,4vw,17px)] leading-loose font-medium text-balance">
            <span className="inline-block">悩みも、弱音も、懺悔も。</span>
            <span className="inline-block">何千年も読まれてきた言葉が、そっと寄り添います。</span>
          </p>
        </div>
      </header>
      <CounselForm />
      <Notices />
      <ThemeToggle />
    </main>
  );
}
