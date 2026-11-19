# Bible RAG Counselor

悩み・愚痴・弱音・懺悔などを書くと、聖書(日本語口語訳)の近い箇所を 3 つ引いて、それぞれの直下に解説、最後に結論を返す Web アプリです。画面と文章は日本語です。

> **位置づけ**: RAG(検索拡張生成)を学ぶために作った、**学習用のリポジトリ**です。RAG は、大まかに学べたところで区切りました。**この RAG 版は、デプロイしません。** 箇所の選び方を LLM に任せる版を、**別のリポジトリで作って、そちらをデプロイする予定**です(まだ計画の段階です)。

- **ユーザーの入力と AI の返答は、DB に保存しません。** ログインも会話履歴もありません
- **聖句は、AI に書かせません。** AI が返すのは、段落の id と解説だけで、本文は DB から取って表示します(引用のでっち上げを防ぐため)
- **命の危険を示す入力は、AI を呼ぶ前に、キーワードで検出して、固定の案内にします。** 死を望む箇所など、出してはいけない箇所は、コードで外します

## 全体像

```
悩み ──▶ 書き換え(LLM) ──▶ ベクトル検索 + 全文検索(RRF) ──▶ 候補 15 件
                                                          └─▶ 選び(LLM)で 3 件 ──▶ 解説と結論(LLM)
                                                              本文は DB から
ブラウザ ──▶ Next.js(App Router)──▶ Postgres + pgvector / OpenRouter
```

## RAG で試したこと

- 段落に分けて、ベクトル(`text-embedding-3-small`)にして、pgvector に入れる。全文検索(日本語は、分かち書きして `tsvector`)と、RRF で合わせる
- 質問の書き換え(現代語を、口語訳の言い回しに)と、LLM による再選択で、当たりを上げる
- 機械の指標と、人の目の比較(目隠しの A/B)で、効果を確かめる。**ベクトルの類似度は、意味の合い方と対応しない**ことも、実測で分かった
- 「聖書にない現代の話題」の扱い、回数制限、危機の検出などの、周りの設計

詳しい決定と理由は [docs/](docs) にあります(検索: [docs/search.md](docs/search.md)、安全: [docs/safety.md](docs/safety.md)、回数制限: [docs/rate-limit.md](docs/rate-limit.md)、DB: [docs/database.md](docs/database.md))。

## 技術スタック

| 分類 | 技術 |
|---|---|
| フレームワーク | Next.js 16(App Router)、React 19 |
| 言語 | TypeScript(strict)、zod(外から来るデータの検証) |
| スタイル | Tailwind CSS 4 |
| DB | Postgres + pgvector(Drizzle ORM / drizzle-kit)。開発は Docker |
| AI | OpenRouter(埋め込み、書き換えと選び、解説と結論) |
| テスト | Vitest |
| フォント | Shippori Mincho(SIL OFL。使う字だけに削った woff2) |

## 手元で動かす

必要なもの: Node.js 22、Docker、OpenRouter の API キー。

```bash
npm ci
cp .env.example .env.local        # 中身を埋める(DATABASE_URL、OPENROUTER_API_KEY など)
docker compose up -d --wait       # Postgres + pgvector を起動(ホストのポートは 5434)
npm run db:migrate                # テーブルを作る
npm run bible:fetch               # 口語訳の XML を取得する(git には入れない)
npm run bible:convert             # 段落の JSON を作る(git には入れない)
npm run db:insert                 # 段落を、ベクトルにして DB に入れる(OpenRouter の費用がかかる)
npm run dev                       # http://localhost:3000
```

- ターミナルから相談する: `npm run counsel`(`-- --debug` で、検索の内訳)
- 画面の各状態の見本(AI を呼ばない): `/dev/preview`(開発のときだけ。本番は 404)
- 確認: `npm run check`(lint・書式・型)、`npm test`

**聖書のデータ(XML と、生成した JSON)は、リポジトリに入れません**(再配布してよいか、未確認のため)。上の手順で、手元に作ります。詳しくは [docs/data.md](docs/data.md)。

## 注意

- 悩みを受ける場所ですが、**専門の相談先ではありません。** 画面の「ご利用にあたって」にも、そう書いてあります
- 相談窓口の名前と電話番号は、**仮の表示**です(公開する場合は、人が公式の情報で確認して入れます)
- 検索エンジンに載せない設定(noindex)を、入れてあります
