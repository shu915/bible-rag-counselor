import { notFound } from "next/navigation";
import { CounselForm } from "../../../counsel-form";
import { Notices } from "../../../notices";
import { Star } from "../../../star";
import { PREVIEW_STATES } from "../states";

export function generateStaticParams() {
  return Object.keys(PREVIEW_STATES).map((state) => ({ state }));
}

// 開発用: 本物の画面と同じ部品に、見本の状態を渡して出す(AI も API も呼ばない)。本番では出さない
export default async function PreviewPage({ params }: PageProps<"/dev/preview/[state]">) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state } = await params;
  const initial = PREVIEW_STATES[state];
  if (!initial) notFound();
  return (
    <main className="mx-auto flex w-full max-w-180 flex-col gap-[clamp(32px,7vw,48px)] px-6 pt-[clamp(24px,6vw,56px)] pb-[clamp(56px,10vw,96px)]">
      <header className="flex flex-col items-center gap-3 pt-10 text-center">
        <Star size={22} className="fill-gold" />
        <h1 className="font-serif text-[clamp(26px,7vw,42px)] font-semibold">
          聖書に、聞いてみる。
        </h1>
      </header>
      <CounselForm initial={initial} />
      <Notices />
    </main>
  );
}
