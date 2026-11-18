# 検証・CI・hooks・リポジトリ運用

## テストと検証

- テストは Vitest(`src/**/*.test.{ts,tsx}` と `scripts/**/*.test.ts`)。CI も手元も、`npm test` で全部を実行する。実データのテストは、XML が無いと、黙って飛ばさず失敗する(先に `npm run bible:fetch`)
- 実装後は hooks が tsc・lint・test を自動で実行する(`build` と整形のチェックは対象外)
- `npm run check` = lint + format:check + typecheck(**テストは含まない**)。コミット前に `npm run format` をかけると、CI の整形チェックで落ちない
- **挙動を変えたら `evaluator` を呼ぶ**(最大5周。同じ指摘が再発したら止める)。報告には、検証していない範囲と、人間向けの確認手順を書く
- テスト改ざんの検出には穴がある(`toBeTruthy` への弱体化、`.github/` や `package.json` から `npm test` を外す変更)。これらは `evaluator` が目視で確認する

## CI(`.github/workflows/ci.yml`)

PR と main への push で、次を実行する: `npm ci` → lint → format:check → `bible:fetch`(出典の XML を取得して、チェックサムを確かめる)→ test → typegen → typecheck → build。実 DB(pgvector)を使うテストを書いたら、`services: postgres` を足す。

## 依存

- **Dependabot(`.github/dependabot.yml`)**: 月1回、minor / patch だけを1つの PR にまとめる。メジャー更新と、Next.js・React・Vitest は手動で上げる(鵜呑みにして壊さないため)
- Dependabot alerts と security updates は、ユーザーの判断でオフ(drizzle-kit 内の古い esbuild の更新が、毎回失敗するため)。有効化も、CI の `npm audit` も、再提案しない
- **依存を足すとき**: macOS の npm は、ロックから他の OS 向けのネイティブ依存(`@rolldown/binding-*` など)を落とすことがあり、CI(Linux)の `npm ci` が失敗する。
  1. `npm install` のあと、`grep -c '"node_modules/@rolldown/binding-' package-lock.json` が 0 でないか、`@rolldown/binding-linux-x64-gnu` が入っているかを確認する
  2. 落ちていたら、`package.json` だけを空のフォルダにコピーして `npm install --package-lock-only` でロックを作り直す
  3. 元のロックと比べて(ダウングレードや消えた依存がないか)から、`package-lock.json` を置き換えて(ガードの対象なので、人がコピーする)、`npm ci` する

## リポジトリ運用

- **main へは直接プッシュできない**(GitHub の Ruleset `protect-main`)。作業ブランチをプッシュして PR を作り、CI の `check` ジョブが成功してからマージする。main の削除と強制プッシュも禁止。例外(bypass)はなく、管理者も同じ。承認者は0人で、未解決のレビューコメントがあるとマージできない
- コミットメッセージ・PR(タイトル・本文)・コード中のコメントは日本語。PR の本文は「概要 / 確認したこと / 未確認・注意」の順で、確認していないことは分けて書く
- 人が頼むまで、コミットしない。マージ済みの PR の履歴を書き換える提案の前には、`gh pr view` でマージ済みかを確かめる

## hooks(`.claude/`)

- `guard-pre.sh` が、次をブロックする: `.env*` の読み書き(コマンドの文字列に環境ファイルのパスが入っているだけでも。引用符の分割やワイルドカードも)、`git clean` / `reset --hard` / `checkout --` / `push --force`、`rm -r`、`find -delete`、`docker compose down -v`、`drizzle-kit push`、`drizzle/` の編集、`data/jpn-kougo.osis.xml`(出典)・`data/bible-paragraphs.json`(生成物)・`package-lock.json` の編集(Bash 経由も)、型や lint を黙らせる記述、テストや設定を弱める変更、**`.claude/hooks/` と `.claude/settings.json` の編集(人が編集する)**
- **ブロックされたら回避せず、理由を報告して指示を待つ**
- **ガードは事故防止であって、悪意への防御ではない**。Bash は書き方を変えれば回避できる(変数の連結 `a=.en; cat ${a}v.local` など、正規表現では防げないものがある)。頼れるのは、`.claude/settings.json` の `permissions.deny`(`.env*` の Read / Edit を拒否)と、秘密情報を人が管理することだけ。**deny が Grep ツールや Bash に効くかは確認できていないので、効く前提で書かない**。`.env.local` の中身が会話に出たら、キーを作り直す
- コマンドを `&&` でつなぐと、別々の操作が1つの文字列として判定され、誤検知でブロックされることがある。分けて実行する
- 既知の誤検知: `jq '.[] | ...'` の `.[`(空白の後ろの `.[` がワイルドカード判定に当たる)。次にガードを更新するとき、空白の後ろの判定を `.*` と `.?` だけにする
- `post-edit.sh` は編集したファイルに ESLint をかけ、`stop-checks.sh` は応答の終わりに typegen・tsc・lint・test を実行して、失敗したら差し戻す
