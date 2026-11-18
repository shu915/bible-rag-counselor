@AGENTS.md

# Bible RAG Counselor

## 目的

- RAG を学習し、使えるようになること(学習が第一目的)
- それなりに実用的なアプリに仕上げること

## アプリの振る舞い

1. ユーザーが「悩み事 / 愚痴・弱音 / 懺悔」を入力する
2. 類似度の高い聖書の箇所を **3件** 取得する
3. 各引用の **直下** に、ユーザーの相談に絡めた解説を表示する
4. 最後に全体をまとめた **結論** を出す

- **聖書の時代にない話題**(AI・ビットコインなど): 「それは聖書には載っていませんが」と最初に断り、一度抽象化した主題(例: 富への執着、新しい技術への不安)に置き換えて回答する
- **プライバシー**: ユーザーの入力と AI の返答は **DB に保存しない**(認証・会話履歴も作らない)
- **回数制限**(ログインなしで誰でも使えるため、費用を守る): ①IP 単位の1日の回数(最初は5回、環境変数で変える) ②全体の1日の上限(環境変数) ③OpenRouter 側の月の上限。AI に届かなかった失敗は数えない、答えたあとの失敗は数える。記録は「IP のハッシュ・日付・回数」だけ。詳細は [docs/rate-limit.md](docs/rate-limit.md)

## 技術スタック

- Next.js (App Router) / TypeScript / Tailwind CSS / zod(外から来るデータの検証)
- DB: Postgres + pgvector(Drizzle ORM / drizzle-kit、接続は `pg`)。本番は Neon、ローカルは Docker
- デプロイ: Vercel
- LLM / 埋め込み: OpenRouter 経由(契約済み)。埋め込みは `openai/text-embedding-3-small`、書き換え・選択(軽い仕事)は `google/gemini-4-hydrogen`(`OPENROUTER_CHAT_MODEL`)、解説と結論(書く仕事)は `anthropic/claude-sonnet-5.5`(`OPENROUTER_WRITING_MODEL`。Gemini は、相談者の気持ちを褒める方に決めつける迎合が出たため。費用はほぼ同じ)

## AI(OpenRouter)の規則

- **API キーを読むのは、OpenRouter を呼ぶ1つのモジュールだけ**にする。ほかの場所から `process.env` で直接読まない
- ユーザーの入力は悩み・弱音・懺悔で、とても繊細な内容。OpenRouter へのリクエストには `provider: { data_collection: "deny" }` を付ける。**入力も返答も、ログに出さない**(本番でも開発でも)
- **Google のモデル(Gemini)は、JSON スキーマの `minLength`・`maxLength`・`minimum`・`maximum`・`minItems`・`maxItems`・`additionalProperties` を 400 で拒否する**。スキーマからは外して、返ってきた JSON を zod で検証する
- LLM に引用文を書かせない。LLM が返すのは「どの段落 `id` について、どう解説するか」だけにして、聖句は `id` で DB から取って表示する。LLM が返した `id` が検索結果の3件に含まれていなければ捨てる
- 実際に AI を呼ぶテスト(`*.live.test.ts`)は、`RUN_LIVE_AI=1` のときだけ動かす(お金がかかるため)

## データ・検索・DB の規則

- 聖書は日本語口語訳。**XML(`data/jpn-kougo.osis.xml`)と生成した JSON(`data/bible-paragraphs.json`)は git に入れない**(再配布してよいか未確認)。新しく clone したら `npm run bible:fetch`、そのあと `npm run bible:convert`。詳細は [docs/data.md](docs/data.md)
- 検索の単位は **段落**。`id`(例 `Matt.6.25-34`)が出典の唯一のキー
- **分かち書きは、文書側(DB 投入)と検索側(ユーザー入力)で同じ関数を使う**([src/lib/tokenizer.ts](src/lib/tokenizer.ts))。ユーザー入力は、長さの上限つきの `tokenizeQuery` を通す。`to_tsquery` に渡すトークンはエスケープする。詳細は [docs/search.md](docs/search.md)
- スキーマ変更は Drizzle のマイグレーションで行う。DB を直接いじらない(**`drizzle-kit push` は禁止**)。`drizzle/` は生成物で手編集しない。**本番(Neon)に適用したあとは、マージ済みのマイグレーションを書き換えない**(本番前は作り直してよい)。詳細は [docs/database.md](docs/database.md)
- `drizzle-kit` は `.env.local` の `DATABASE_URL` を読む。**未設定ならエラーで止まる**。実行のたびに接続先が表示されるので、本番に向けるときは必ず確認する
- 実 DB を使うテストは、本物のデータが入った DB を指さない(テスト用の DB を別に用意する)

## 開発ルール

- 秘密情報は `.env.local` に置き、コミットしない。`.env*` は読まない・編集しない(`.env.example` は可)
- ルートを足す・消したら `npx next typegen` を実行する
- `strict: true`。`any`、`as unknown as`、`@ts-ignore`、`@ts-expect-error`、`eslint-disable` は使わない(必要なら理由を1行のコメントで書く)。外から来るデータ(API の返答、JSON ファイルなど)は `unknown` で受け、zod などで検証してから型を付ける
- **テストを通すための改ざんは禁止**: テストの削除・`skip`・`only`、期待値を実装に合わせて弱める、型や lint を黙らせる、tsconfig や ESLint を緩める。テストが落ちたら、まず実装が間違っていると考える。やむを得ないときは、理由を報告して人の確認を待つ
- **依存を足すとき**: macOS の npm が、ロックからネイティブ依存(`@rolldown/binding-*`)を落とすことがある。確認と作り直しの手順は [docs/harness.md](docs/harness.md)
- **挙動を変えたら `evaluator` を呼ぶ**(最大5周。同じ指摘が再発したら止める)。報告には、検証していない範囲と、人間向けの確認手順を書く

## コマンド

- `npm run dev` / `build` / `lint` / `typecheck` / `test`(Vitest)/ `format` / `format:check`
- `npm run check` = lint + format:check + typecheck(**テストは含まない**)。コミット前に `npm run format` をかける
- `npm run bible:fetch`(出典の取得)/ `bible:convert`(JSON の生成)
- DB: `docker compose up -d --wait`(ポートは **5434**)、`npm run db:generate -- --name <名前>` → `npm run db:migrate`、`db:studio`

## コミットと hooks

- **人が頼むまで、コミットしない**。作業ブランチを切って進める
- **main へは直接プッシュできない**(Ruleset `protect-main`)。作業ブランチをプッシュして PR を作り、CI の `check` が成功してからマージする
- コミットメッセージ・PR・コード中のコメントは日本語。PR の本文は「概要 / 確認したこと / 未確認・注意」の順
- `.claude/hooks/guard-pre.sh` が、危険な操作(`.env*`、`git clean` / `reset --hard` / `push --force`、`rm -r`、`drizzle-kit push`、`drizzle/`・`package-lock.json`・XML・生成 JSON の編集、`.claude/hooks/` と `settings.json` の編集など)をブロックする。**ブロックされたら回避せず、理由を報告して指示を待つ**。ガードは事故防止であって、悪意への防御ではない
- コマンドを `&&` でつなぐと、誤検知でブロックされることがある。分けて実行する
- 新しいセッションは、最初にこのファイルと [claude-progress.txt](claude-progress.txt) を読む。作業の区切りごとに `claude-progress.txt` を更新する

## 詳細ドキュメント(`docs/`)

| ファイル | 内容 |
|---|---|
| [docs/data.md](docs/data.md) | 聖書データの出典・取得・変換・JSON のフォーマット・用語・既知の例外 |
| [docs/search.md](docs/search.md) | ハイブリッド検索、分かち書きの仕様・既知の限界 |
| [docs/database.md](docs/database.md) | テーブル定義、DB 投入、マイグレーション、ローカルの Docker |
| [docs/rate-limit.md](docs/rate-limit.md) | 回数制限の設計 |
| [docs/cost.md](docs/cost.md) | 費用の試算 |
| [docs/harness.md](docs/harness.md) | テスト・CI・依存・リポジトリ運用・hooks の詳細 |

## このファイルの保ち方

- このファイルには、要件と**毎回守る規則**だけを書く。機能ごとの詳細な仕様は `docs/` に書き、ここには索引を置く
- コードを読めば分かることは書かない。決定には理由を1行で添える
