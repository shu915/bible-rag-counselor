# 聖書データ

## 出典と取得

- 聖書は **日本語口語訳(1954/1955年版)**。OSIS XML を `data/jpn-kougo.osis.xml` に置く。**git には入れない**(`.gitignore`)
- 出典: https://github.com/seven1m/open-bibles の `jpn-kougo.osis.xml`。配布元の一覧では Public Domain だが、口語訳の個別の根拠は書かれておらず、こちらでは確認できていない。再配布してよいかを確認できていないので、公開リポジトリには置かない。全文は、テストやドキュメントにも載せない
- **`npm run bible:fetch`** で、配布元から取得する([scripts/fetch-osis.ts](../scripts/fetch-osis.ts))。コミット(`SOURCE_COMMIT`)を固定し、SHA-256(`EXPECTED_SHA256`)を確かめる。すでにあって一致していれば何もしない。CI も同じコマンドを使う。新しく clone したら、これを実行する
- 取得元を更新するときは、`SOURCE_COMMIT` と `EXPECTED_SHA256` を、人が確かめて書き換える
- main の履歴には、XML が残っている(`cc269fd` が追加。誤ってコミットした)。履歴から消すには Ruleset を外して強制プッシュが必要で、現在は消さない判断

## 変換

`npm run bible:convert`([scripts/convert-osis.ts](../scripts/convert-osis.ts))で、XML から `data/bible-paragraphs.json` を生成する。変換の本体は、ファイルを読み書きしない純粋な関数 [scripts/parse-osis.ts](../scripts/parse-osis.ts)。

- 出力は 5,709 段落 / 31,088 節。生成物なので `.gitignore` 対象(XML も同様)
- **検索の単位は段落**。節は1節だけだと文脈が足りないため。引用の表示は節番号付き(例: マタイ6章25-34節)
- 段落は `<chapter>` / `<p>` / `<lg>` を境界にして節をまとめたもの
- ルビ(`<w gloss>`)は除去して、漢字だけにしている

## JSON のフォーマット

`id`(例 `Matt.6.25-34`、1節なら `Matt.1.1`)、`book_key`、`book_name`、`testament`、`book_order`、`chapter`、`verse_start`、`verse_end`、`verses: [{verse, verse_end, text}]`

- `id` は引用の出典としてそのまま確認できる一意なキー。表示する聖句は LLM に書かせず、必ず `id` で DB から取って表示する
- `testament`(`OT` / `NT`)と `book_order`(1〜66)は、SQL の絞り込み・並べ替えに使うので持つ。対応表は [scripts/books.ts](../scripts/books.ts)(XML は新約が先に並ぶので、出現順は使えない。表にない書キーは止まる)
- 表示用の出典ラベル(`reference`)や、ベクトル化・検索用の本文は、他の列から作れる・試して変えるものなので、JSON に持たない。本文は DB 投入時に `verses` を結合して作る
- 元データには2節が1つにまとまった節(例: `Rom.1.9 Rom.1.10`、16件)があり、`verse` 〜 `verse_end` の範囲で持つ
- **既知の例外**: 出エジプト記22章は、口語訳の節順が標準と違い、`Exod.22.1-4`(1,3,4節)と `Exod.22.2-3`(2,3節)の2段落に分かれる

## 用語

書(book) > 章(chapter) > 段落(paragraph) > 節(verse)。章と節は聖書の番号、段落は口語訳テキストの区切り。「句」は使わない。

## 確認済みの整合性

66 書、1,189 章(旧約 929・新約 260)、各章の節番号に飛びなし。節の総数は、2節まとめを展開すると 31,104 で、標準(KJV の 31,102)と 2 節違う(口語訳の区切りの違い)。本文の中身(文字の欠けなど)は、確認していない。

テストは [scripts/parse-osis.test.ts](../scripts/parse-osis.test.ts)(自作の小さな XML)と [scripts/parse-osis.real-data.test.ts](../scripts/parse-osis.real-data.test.ts)(実際の XML。件数と整合性、書の番号。XML が無いと、飛ばさず失敗する)、[scripts/checksum.test.ts](../scripts/checksum.test.ts)。
