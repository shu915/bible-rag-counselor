import { CounselForm } from "./counsel-form";
import { Notices } from "./notices";

// 相談の画面。いまは「裸」(飾りなし)。見た目は、後で、Claude Design に作ってもらったものに差し替える
export default function Home() {
  return (
    <main className="mx-auto w-full max-w-2xl p-6">
      <h1>聖書に、聞いてみる。</h1>
      <p>悩みも、弱音も、懺悔も。何千年も読まれてきた言葉が、そっと寄り添います。</p>
      <p>無料 ・ 書いた内容は保存されません</p>
      <CounselForm />
      <Notices />
    </main>
  );
}
