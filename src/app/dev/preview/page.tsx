import { notFound } from "next/navigation";
import Link from "next/link";
import { PREVIEW_STATES } from "./states";

// 開発用: 画面の各状態の一覧(AI も API も呼ばない)。本番では出さない
export default function PreviewIndex() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto max-w-180 p-6">
      <h1 className="mb-4 text-xl font-bold">画面の見本(開発用)</h1>
      <ul className="flex flex-col gap-2">
        {Object.keys(PREVIEW_STATES).map((key) => (
          <li key={key}>
            <Link className="text-primary underline" href={`/dev/preview/${key}`}>
              {key}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
