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

### 聖書の時代にない話題(AI・ビットコインなど)
- 「それは聖書には載っていませんが」と最初に断る
- その上で、一度抽象化した主題(例: 富への執着、新しい技術への不安)に置き換えて回答する

### プライバシー
- ユーザーの入力と AI の返答は **DB に保存しない**(認証・会話履歴も作らない)

### 回数制限
- ログインがなく、誰でも使える。野良で使われる可能性は承知のうえで、次の3段で費用を守る
  1. **IP 単位の1日の回数制限**: 最初は5回(環境変数で変えられるようにする。使われ方を見て5〜10回の範囲で調整)
  2. **全体の1日の上限**(例: 300回。環境変数で変える)
  3. **OpenRouter 側の月の上限**(ダッシュボードで設定する)
- AI に届かなかった失敗(接続・設定・AI のエラー)は数えない。AI が答えたあとの失敗は数える(わざと失敗させて、上限なしに AI を呼ぶのを防ぐため)
- 回数の記録は「IP のハッシュ・日付・回数」だけ。IP は生で持たない。悩みの内容は一切入れない(入力と返答を保存しない方針と両立させる)

## 技術スタック
- Next.js (App Router) / TypeScript / Tailwind CSS / zod(外から来るデータの検証)
- DB: Postgres + pgvector(スキーマ管理は Drizzle ORM / drizzle-kit、接続は `pg`)
  - 本番: Neon
  - ローカル: Docker
- デプロイ: Vercel
- LLM / 埋め込み: OpenRouter 経由で一括利用(契約済み)
  - 埋め込み: `openai/text-embedding-3-small`(下記「未決事項」参照)
  - テキスト生成: `google/gemini-4-hydrogen`(OpenRouter のモデル ID。2026-11-17 に実在を確認。入力 $1.5 / 出力 $7.5 per 1M tokens)

## 検索
- ベクトル検索(pgvector)に加えて **ハイブリッド検索**(全文/キーワード検索との併用)を実装する。学習目的なので仕組みを理解しながら進める

### 日本語の全文検索(分かち書き)
- Neon の標準の全文検索は日本語を単語に区切れないため、**アプリ側で形態素解析して空白区切りにした文字列**を Postgres に渡す(`simple` 設定の `tsvector`)
- 形態素解析は kuromoji 系を第一候補にする(原形と品詞が取れる)。`Intl.Segmenter('ja')` は比較用。Vercel では辞書ファイルをデプロイに含める設定が要る
- 検索用トークンは **名詞・動詞・形容詞の原形** だけ残す(例: 「愛しています」→ `愛する`)。助詞・助動詞は捨てる
- **文書側(DB 投入時)と検索側(ユーザー入力時)で必ず同じ関数を使う**。分かち書きの関数を1つ作り、投入スクリプトとアプリの両方から呼ぶ
- 検索側のクエリはトークンを `OR` でつなぎ、ベクトル検索の結果とは RRF(Reciprocal Rank Fusion)で順位統合する

## DB 投入
- 投入スクリプトは `data/bible-paragraphs.json` から1段落ごとに、①本文を作る(`verses` を結合) ②分かち書き ③エンベディング(OpenRouter) をして、1行にまとめて INSERT する
- 分かち書きとエンベディングは JSON 作成時ではなく **DB 投入時** にやる(解析器やプレフィックスを変えて試すとき、投入の再実行だけで済むようにするため)
- ローカル(Docker)と本番(Neon)は、接続先だけ切り替えて同じスクリプトを使う
- エンベディングは100件ずつなどまとめて API に送る。挿入済みの `id` は飛ばして、途中で失敗しても続きから再開できるようにする
- テーブルの列(案): `id`(PK、`Matt.6.25-34`)、`book_key`、`book_name`、`testament`(`OT` / `NT`)、`book_order`(1〜66)、`chapter`、`verse_start`、`verse_end`、`verses`(JSONB)、`content_tokens`、`search_tsv`(GIN)、`embedding vector(1536)`
- 5,709行なので、ベクトルの索引(HNSW など)は不要で、全件スキャンで足りる。行数が増えたら検討する

## 費用の試算(2026-11-17 時点、OpenRouter の公開価格。1ドル=150円で換算)
- **エンベディング(最初の1回)**: 5,709段落 / 1,756,213字 / 約189万トークン(cl100k_base での実測)。`text-embedding-3-small` は $0.02 per 1M tokens なので **約 $0.04(約6円)**。プレフィックス付き案を試しても +約8.5万トークン。何度やり直してもほぼ無料
- **1回の相談(実行時)**: 約 $0.014〜0.03(約2〜4.5円)。内訳は、入力約1,800トークン(システム指示+悩み+引用3件)で約 $0.003、出力約1,500トークンで約 $0.011、推論(reasoning)トークンがあれば約 $0.015 まで上乗せ。出力が大半を占める。クエリの埋め込みは無視できる額
- **1,000回の相談**: 約 $14〜30(約2,000〜4,500円)。実際の使用量(特に推論トークン)は動かして確認する
- **DB 容量**: ベクトルだけで約35MB(5,709 × 1,536 × 4バイト)、テキストなどを足して100MB前後の見込み
- 長い段落でも最大約3,000トークンで、エンベディングの上限(8,191)には収まる

## データ
- 聖書は **日本語口語訳(1954/1955年版)**。OSIS XML を `data/jpn-kougo.osis.xml` に置く。**git には入れない**(`.gitignore`)。出典は https://github.com/seven1m/open-bibles の `jpn-kougo.osis.xml`(配布元の一覧では Public Domain。口語訳の個別の根拠は書かれておらず、こちらでは確認できていない)。再配布してよいかを確認できていないので、公開リポジトリには置かない。**`npm run bible:fetch` で、配布元から取得する**(コミットを固定し、SHA-256 を確かめる。すでにあって一致していれば何もしない。CI も同じコマンドを使う)。新しく clone したら、これを実行する
- `npm run bible:convert`([scripts/convert-osis.ts](scripts/convert-osis.ts))で XML から JSON を生成する(前身プロジェクト rag-bible から移植)
  - 出力は `data/bible-paragraphs.json` のみ(5,709段落 / 31,088節)。生成物なので `.gitignore` 対象。XML も `.gitignore` 対象で、どちらも git に入れない
  - **検索の単位は段落**。節は1節だけだと文脈が足りないため。引用の表示は節番号付き(例: マタイ6章25-34節)
  - 段落は `<chapter>` / `<p>` / `<lg>` を境界にして節をまとめたもの
  - フォーマット: `id`(例 `Matt.6.25-34`、1節なら `Matt.1.1`)、`book_key`、`book_name`、`testament`、`book_order`、`chapter`、`verse_start`、`verse_end`、`verses: [{verse, verse_end, text}]`
  - `testament` と `book_order` は、SQL の絞り込み・並べ替えに使うので持つ。対応表は [scripts/books.ts](scripts/books.ts)(XML は新約が先に並ぶので、出現順は使えない)。表示用の出典ラベル(`reference`)やベクトル化用のテキストは、他の列から作れる・試して変えるものなので JSON に持たない
  - `id` は引用の出典としてそのまま確認できる一意なキー。表示する聖句は LLM に書かせず、必ず `id` で DB から取って表示する
  - 検索用の本文とベクトル化用テキストは、DB 投入時に `verses` を結合して作る(JSON には持たない)
  - 元データには2節が1つにまとまった節(例: `Rom.1.9 Rom.1.10`、16件)があり、`verse` 〜 `verse_end` の範囲で持つ
  - 既知の例外: 出エジプト記22章は口語訳の節順が標準と違い、`Exod.22.1-4`(1,3,4節)と `Exod.22.2-3`(2,3節)の2段落に分かれる
  - ルビ(`<w gloss>`)は除去して漢字だけにしている
- 用語: 書(book) > 章(chapter) > 段落(paragraph) > 節(verse)。章と節は聖書の番号、段落は口語訳テキストの区切り。「句」は使わない
- 埋め込み生成と DB 投入のスクリプトも作る(未着手)

## 未決事項
- 長すぎる段落(最大約2,700字)を分割するか
- ベクトル化するテキストに書名・章節のプレフィックスを付けるか(付けない案で始めて、後で比較する)
- 埋め込みモデルは `text-embedding-3-small` で確定してよいか
- ハイブリッド検索の全文検索方式(日本語の場合の扱い)
- 聖書 JSON の保管ディレクトリ

## AI(OpenRouter)の規則
- **API キーを読むのは、OpenRouter を呼ぶ1つのモジュールだけ**にする。ほかの場所から `process.env` で直接読まない
- ユーザーの入力は悩み・弱音・懺悔で、とても繊細な内容。OpenRouter へのリクエストには `provider: { data_collection: "deny" }` を付ける。**入力も返答も、ログに出さない**(本番でも開発でも)
- **Google のモデル(Gemini)は、JSON スキーマの `minLength`・`maxLength`・`minimum`・`maximum`・`minItems`・`maxItems`・`additionalProperties` を 400 で拒否する**。スキーマからは外して、返ってきた JSON を zod で検証する
- LLM に引用文を書かせない。LLM が返すのは「どの段落 `id` について、どう解説するか」だけにして、聖句は `id` で DB から取って表示する。LLM が返した `id` が検索結果の3件に含まれていなければ捨てる
- 実際に AI を呼ぶテスト(`*.live.test.ts`)は、`RUN_LIVE_AI=1` のときだけ動かす(お金がかかるため)

## 開発ルール
- 秘密情報は `.env.local` に置き、コミットしない。`.env*` は読まない・編集しない(`.env.example` は可)
- ルートを足す・消したら `npx next typegen` を実行する
- `strict: true`。`any`、`as unknown as`、`@ts-ignore`、`@ts-expect-error`、`eslint-disable` は使わない(必要なら理由を1行のコメントで書く)。外から来るデータ(API の返答、JSON ファイルなど)は `unknown` で受け、zod などで検証してから型を付ける
- **テストを通すための改ざんは禁止**: テストの削除・`skip`・`only`、期待値を実装に合わせて弱める、型や lint を黙らせる、tsconfig や ESLint を緩める。テストが落ちたら、まず実装が間違っていると考える。やむを得ないときは、理由を報告して人の確認を待つ
- 実 DB を使うテストは、本物のデータが入った DB を指さない(テスト用の DB を別に用意する)

## コマンド
- `npm run dev` / `build` / `lint` / `typecheck` / `test`(Vitest)/ `format`(Prettier で整形)/ `format:check`
- `npm run check` = lint + format:check + typecheck(**テストは含まない**)。コミット前に `npm run format` をかけると、CI の整形チェックで落ちない
- `npm run bible:fetch`: 出典の XML を、配布元から `data/` に取得する(チェックサムを確かめる)
- `npm run bible:convert`: XML から `data/bible-paragraphs.json` を生成する
- DB(ローカル): `docker compose up -d --wait`(Postgres 17 + pgvector。ホストのポートは **5434**。他プロジェクトが 5432 / 5433 を使っているため)。止めるのは `docker compose down`(データは残る。消すときは `-v`)
- スキーマ変更は Drizzle のマイグレーションで行う(`npm run db:generate -- --name <説明的な名前>` → `npm run db:migrate`。`db:studio` で中身を見られる)。DB を直接いじらない(`drizzle-kit push` は禁止)。`drizzle/` は生成物で手編集しない(`*_enable_pgvector.sql` の手書きマイグレーションだけ例外)。**本番(Neon)に適用したあとは、マージ済みのマイグレーションを書き換えない**(本番に出すまでは、作り直してよい。消して `db:generate` をやり直し、ローカルの DB は空に戻す)
- pgvector の `vector` 型は Drizzle の標準の型で書ける。`tsvector` は `customType` で型名だけ教えて、生成列は `generatedAlwaysAs` で書く(`src/db/schema.ts`)。それでも書けないものは、カスタムマイグレーション(生の SQL)で足す
- `drizzle-kit` は `.env.local` の `DATABASE_URL` を読む(`drizzle.config.ts`)。**未設定ならエラーで止まる**(黙ってローカルに向かわない)。実行のたびに接続先(ホスト・ポート・DB 名)が表示されるので、本番に向けるときは必ず確認する。すでにシェルにある環境変数は `.env.local` より優先される
- 接続文字列は `.env.example` を参照(`DATABASE_URL=postgres://postgres:postgres@localhost:5434/bible_rag`)。`vector` 拡張は、最初のマイグレーション(`drizzle/0000_enable_pgvector.sql`)で有効にする(ローカルも Neon も `db:migrate` だけで同じ状態になる)

## 検証と評価
- 実装後は hooks が tsc・lint・test を自動で実行する(`build` と整形のチェックは対象外)
- **CI(`.github/workflows/ci.yml`)**: PR と main への push で、`npm ci` → lint → format:check → `bible:fetch`(出典の XML を取得して、チェックサムを確かめる)→ test → typegen → typecheck → build を実行する。実 DB(pgvector)を使うテストを書いたら、`services: postgres` を足す
- **Dependabot(`.github/dependabot.yml`)**: 月1回、minor / patch だけを1つの PR にまとめる。メジャー更新と、Next.js・React・Vitest は手動で上げる(鵜呑みにして壊さないため)
- **依存を足すとき**: macOS の npm は、ロックから他の OS 向けのネイティブ依存(`@rolldown/binding-*` など)を落とすことがあり、CI(Linux)の `npm ci` が失敗する。`npm install` したあとに `grep -c '"node_modules/@rolldown/binding-' package-lock.json` が 0 でないか、`@rolldown/binding-linux-x64-gnu` が入っているかを確認する。落ちていたら、`package.json` だけを空のフォルダにコピーして `npm install --package-lock-only` でロックを作り直し、元のロックと比べて(ダウングレードや消えた依存がないか)から入れて `npm ci` する
- テストは Vitest(`src/**/*.test.{ts,tsx}` と `scripts/**/*.test.ts`)。聖書の XML の変換は `scripts/parse-osis.ts`(純粋な関数)にある。自作の小さな XML のテスト(`parse-osis.test.ts`)と、実際の XML を使うテスト(`parse-osis.real-data.test.ts`。件数と整合性を守る)がある。実データのテストは、XML が無いと、黙って飛ばさず失敗する(先に `npm run bible:fetch`)。チェックサムの検証にもテストがある(`checksum.test.ts`)。CI も手元も、`npm test` で全部を実行する
- **挙動を変えたら `evaluator` を呼ぶ**(最大5周。同じ指摘が再発したら止める)。報告には、検証していない範囲と、人間向けの確認手順を書く

## コミットと hooks
- 人が頼むまでコミットしない
- ブランチ運用: 作業ブランチを切って進める(現在は `feature/setup-environment`)
- **main へは直接プッシュできない**(GitHub の Ruleset `protect-main`。habit-and-health-tracker と同じ設定)。作業ブランチをプッシュして PR を作り、CI の `check` ジョブが成功してからマージする。main の削除と強制プッシュも禁止。例外(bypass)はなく、管理者も同じ。承認者は0人で、未解決のレビューコメントがあるとマージできない
- コミットメッセージ・PR(タイトル・本文)・コード中のコメントは日本語。PR の本文は「概要 / 確認したこと / 未確認・注意」の順で、確認していないことは分けて書く
- `.claude/hooks/guard-pre.sh` がブロックする: `.env*` の読み書き(コマンドの文字列に環境ファイルのパスが入っているだけでも。引用符の分割やワイルドカードも)、`git clean` / `reset --hard` / `checkout --` / `push --force`、`rm -r`、`find -delete`、`docker compose down -v`、`drizzle-kit push`、`drizzle/` の編集、`data/jpn-kougo.osis.xml`(出典)・`data/bible-paragraphs.json`(生成物)・`package-lock.json` の編集(Bash 経由も)、型や lint を黙らせる記述、テストや設定を弱める変更、**`.claude/hooks/` と `.claude/settings.json` の編集(人が編集する)**。**ブロックされたら回避せず、理由を報告して指示を待つ**
- **ガードは事故防止であって、悪意への防御ではない**。Bash は書き方を変えれば回避できる(変数の連結 `a=.en; cat ${a}v.local` など、正規表現では防げないものがある)。頼れるのは、`.claude/settings.json` の `permissions.deny`(`.env*` の Read / Edit を拒否)と、秘密情報を人が管理することだけ。**deny が Grep ツールや Bash に効くかは確認できていないので、効く前提で書かない**。`.env.local` の中身が会話に出たら、キーを作り直す
- テスト改ざんの検出には穴がある(`toBeTruthy` への弱体化、`.github/` や `package.json` から `npm test` を外す変更)。これらは `evaluator` が目視で確認する
- コマンドを `&&` でつなぐと、別々の操作が1つの文字列として判定され、誤検知でブロックされることがある。分けて実行する
- `post-edit.sh` は編集したファイルに ESLint をかけ、`stop-checks.sh` は応答の終わりに typegen・tsc・lint・test を実行して、失敗したら差し戻す
- 新しいセッションは、最初にこのファイルと `claude-progress.txt` を読む。作業の区切りごとに `claude-progress.txt` を更新する

## このファイルの保ち方
- このファイルには、要件と**毎回守る規則**だけを書く。機能ごとの詳細な仕様が増えたら `docs/` に分け、ここには索引を置く
- コードを読めば分かることは書かない。決定には理由を1行で添える
