# DB(Postgres + pgvector、Drizzle)

## テーブル `paragraphs`(1段落 = 1行)

定義は [src/db/schema.ts](../src/db/schema.ts)。マイグレーションは `drizzle/0000_enable_pgvector.sql`(拡張機能)と `drizzle/0001_create_paragraphs.sql`。

| 列 | 型 | 説明 |
|---|---|---|
| `id` | text、PK | `Matt.6.25-34`。引用の出典としてそのまま確認できるキー |
| `book_key` / `book_name` | text | `Matt` / マタイによる福音書 |
| `testament` | text | `OT` か `NT`(CHECK)。絞り込み用 |
| `book_order` | smallint | 1〜66(CHECK)。並べ替え用 |
| `chapter` | smallint | 1 以上(CHECK) |
| `verse_start` / `verse_end` | smallint | `verse_start <= verse_end`(CHECK) |
| `verses` | jsonb | `[{verse, verse_end, text}]`。表示用で、検索には使わない。読み出すと `unknown` なので、zod で検証する |
| `content_tokens` | text | 分かち書きした文字列(空白区切り) |
| `search_tsv` | tsvector | **生成列**(`to_tsvector('simple', content_tokens)`、GIN)。DB が作る |
| `embedding` | vector(1536) | `text-embedding-3-small` |

- 本文(`content`)の列は持たない(`verses` を結合すれば作れる。二重管理を避ける)
- ベクトルの索引(HNSW など)は張らない。5,709 行なので、全件スキャンで足りる。行数が増えたら検討する
- `testament` / `book_order` にも索引は張らない(行数が少ない)
- `vector` 型は Drizzle の標準の型。`tsvector` は `customType` で型名だけ教え、生成列は `generatedAlwaysAs` で書く。それでも書けないものは、カスタムマイグレーション(生の SQL)で足す

## DB 投入

実装: [scripts/insert-paragraphs.ts](../scripts/insert-paragraphs.ts)(通信・DB を使わない部分は [scripts/insert-lib.ts](../scripts/insert-lib.ts))。

- 実行: `npm run db:insert`(全段落)/ `npm run db:insert -- --limit 20`(先頭の20件だけ。試しに動かす)/ `npm run db:insert -- --allow-remote`(**ローカル以外**に入れるとき。付けないと、止まる)。実行のたびに、接続先を表示する
- 途中で失敗しても、もう一度実行すれば、入っていない段落から続きをやる(1回の送信ごとに INSERT する)。**既存の行は更新しない**ので、分かち書きを変えたり、列を足したりしたら、`paragraphs` を空にして入れ直す
- 1回の送信は、100件まで、かつ本文の合計 10 万字まで
- `data/bible-paragraphs.json` から1段落ごとに、①本文を作る(`verses` を結合) ②分かち書き(`tokenize`) ③エンベディング(OpenRouter) をして、1行にまとめて INSERT する
- **エンベディングのモデルは、コードの定数**(`EMBEDDING_MODEL`、[src/lib/openrouter.ts](../src/lib/openrouter.ts))。環境変数にしない。**変えたら、全件を入れ直す**(ベクトルの空間が変わる。次元数が違えば、マイグレーションも要る)。文書側と検索側で、必ず同じ定数を使う
- 分かち書きとエンベディングは、JSON 作成時ではなく **DB 投入時** にやる(解析器やプレフィックスを変えて試すとき、投入の再実行だけで済むようにするため)
- ローカル(Docker)と本番(Neon)は、接続先だけ切り替えて同じスクリプトを使う
- エンベディングは100件ずつなどまとめて API に送る。挿入済みの `id` は飛ばして、途中で失敗しても続きから再開できるようにする(既存行の新しい列は埋まらないので、列を足したら UPDATE か、入れ直しが要る)

## マイグレーション(Drizzle)

- スキーマ変更は Drizzle のマイグレーションで行う: `npm run db:generate -- --name <説明的な名前>` → `npm run db:migrate`。`db:studio` で中身を見られる
- DB を直接いじらない。**`drizzle-kit push` は禁止**。`drizzle/` は生成物で手編集しない(`*_enable_pgvector.sql` の手書きだけ例外)
- **本番(Neon)に適用したあとは、マージ済みのマイグレーションを書き換えない**。本番に出すまでは、作り直してよい(`npx drizzle-kit drop` で消して `db:generate` をやり直し、ローカルの DB は空に戻す)
- `vector` 拡張は、最初のマイグレーションで有効にする(ローカルも Neon も `db:migrate` だけで同じ状態になる)。**Neon で、マイグレーションを実行するロールが `CREATE EXTENSION` できるかは、未確認**。本番の初回の前に確かめる
- `drizzle-kit` は `.env.local` の `DATABASE_URL` を読む([drizzle.config.ts](../drizzle.config.ts))。**未設定ならエラーで止まる**(黙ってローカルに向かわない)。実行のたびに接続先(ホスト・ポート・DB 名)が表示されるので、本番に向けるときは必ず確認する。すでにシェルにある環境変数は `.env.local` より優先される

## ローカル(Docker)

- `docker compose up -d --wait`(Postgres 17 + pgvector。DB 名 `bible_rag`)。ホストのポートは **5434**(他プロジェクトが 5432 / 5433 を使っているため)。止めるのは `docker compose down`(データは残る。消すときは `-v`)
- 接続文字列は `.env.example` を参照(`DATABASE_URL=postgres://postgres:postgres@localhost:5434/bible_rag`)
- 実 DB を使うテストは、本物のデータが入った DB を指さない(テスト用の DB を別に用意する)
