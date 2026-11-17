import * as fs from "fs";
import * as path from "path";
import { assertChecksum, sha256Hex } from "./checksum";

// 出典の XML(口語訳)を、配布元からダウンロードして、チェックサムを確かめて、data/ に置く。
//
// 出典: https://github.com/seven1m/open-bibles の jpn-kougo.osis.xml
//       (配布元の一覧では Public Domain。口語訳の個別の根拠は書かれていないので、こちらでは確認できていない)
// 再配布してよいかを確認できていないので、XML はリポジトリに入れず(.gitignore)、ここで取得する。
//
// 配布元の内容があとから変わっても、黙って使わないように、コミットを固定し、SHA-256 を確かめる。
// 配布元を更新したいときは、SOURCE_COMMIT と EXPECTED_SHA256 を、人が確かめて書き換える。
const SOURCE_COMMIT = "3ca49fb73163f42297a32b7b1b1c40cf3dafd84b";
const SOURCE_URL = `https://raw.githubusercontent.com/seven1m/open-bibles/${SOURCE_COMMIT}/jpn-kougo.osis.xml`;
const EXPECTED_SHA256 = "6930015f5d0faf49f3038a7e2f482aeb45939510b6acb8a8fb1945640c1d91b6";

async function main() {
  // どこから実行しても同じ場所を指すように、スクリプトの位置(scripts/)を基準にする。
  // package.json が "type": "module" になったら __dirname は使えない(import.meta.dirname に変える)
  const root = path.resolve(__dirname, "..");
  const destination = path.join(root, "data", "jpn-kougo.osis.xml");

  if (fs.existsSync(destination)) {
    const current = fs.readFileSync(destination);
    if (sha256Hex(current) === EXPECTED_SHA256) {
      console.log(`取得済みで、チェックサムも一致しています: ${destination}`);
      return;
    }
    // 手元のファイルを、黙って上書きしない
    throw new Error(
      `${destination} がすでにありますが、期待したチェックサムと違います。` +
        `別の版を使っているのでなければ、そのファイルを削除してから、もう一度実行してください`,
    );
  }

  console.log(`ダウンロードします: ${SOURCE_URL}`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`ダウンロードに失敗しました(HTTP ${response.status})`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  assertChecksum(data, EXPECTED_SHA256, "ダウンロードした XML");

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // 途中で失敗しても、中途半端なファイルが残らないように、一時ファイルに書いてから移す
  const temporary = `${destination}.download`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, destination);
  console.log(`保存しました(${data.length} バイト、チェックサム一致): ${destination}`);
}

main().catch((error) => {
  console.error("エラーが発生しました:", error);
  process.exit(1);
});
