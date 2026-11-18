// アプリ(API ルート)から使う、Postgres への接続。DB は読むだけ(ユーザーの入力・返答は保存しない)。
// 接続文字列は DATABASE_URL(本番は Neon、ローカルは Docker)。
// 開発中のホットリロードで、接続が増えすぎないよう、モジュールの中で1つだけ作って使い回す。
// TODO(デプロイの前): Vercel(サーバーレス)では、接続の数に注意が要る。Neon のプール用の接続文字列を使う
import { Pool } from "pg";
import type { Queryable } from "@/lib/search-passages";

let pool: Pool | undefined;

// 接続の設定。サーバーレスでは、待機中の接続が、相手(Neon)に切られることがあるので、
// - error イベントを受ける(受けないと、未処理のエラーで、プロセスごと落ちる。メッセージは、出さない)
// - 接続・問い合わせに、時間の上限を付ける(全体の締め切りは、DB の問い合わせには効かないため)
function createPool(connectionString: string): Pool {
  const created = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // サーバー側(Postgres)と、クライアント側(pg)の、両方で、問い合わせの上限を付ける
    statement_timeout: 20_000,
    query_timeout: 25_000,
  });
  created.on("error", () => undefined);
  return created;
}

export function getDb(): Queryable {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL が未設定です");
  pool ??= createPool(connectionString);
  const activePool = pool;
  return {
    async query(text, values) {
      const result = await activePool.query(text, values);
      return { rows: result.rows };
    },
  };
}
