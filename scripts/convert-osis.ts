import * as fs from "fs";
import * as path from "path";
import { parseOsis } from "./parse-osis";

// XML(data/jpn-kougo.osis.xml)を読み、段落ごとの JSON(data/bible-paragraphs.json)を書き出す。
// 変換の中身は parse-osis.ts。
function main() {
  // どこから実行しても同じ場所を指すように、スクリプトの位置(scripts/)を基準にする。
  // package.json が "type": "module" になったら __dirname は使えない(import.meta.dirname に変える)
  const root = path.resolve(__dirname, "..");
  const inputXmlPath = path.join(root, "data", "jpn-kougo.osis.xml");
  const outputPath = path.join(root, "data", "bible-paragraphs.json");

  console.log(`Reading XML from: ${inputXmlPath}`);
  const xmlContent = fs.readFileSync(inputXmlPath, "utf-8");

  const { paragraphs, verseCount } = parseOsis(xmlContent);
  console.log(`抽出完了: 合計 ${verseCount} 節 / ${paragraphs.length} 段落`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(paragraphs, null, 2), "utf-8");
  console.log(`JSON保存完了: ${outputPath}`);
}

try {
  main();
} catch (err) {
  console.error("エラーが発生しました:", err);
  process.exit(1);
}
