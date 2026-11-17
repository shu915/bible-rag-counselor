import { createHash } from "crypto";

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// 期待したチェックサムと違えば、エラーにする。
// 配布元の内容が、あとから書き換えられても、黙って使わないため。内容そのものは、メッセージに出さない
export function assertChecksum(data: Uint8Array, expected: string, label: string): void {
  const actual = sha256Hex(data);
  if (actual !== expected) {
    throw new Error(
      `${label} のチェックサムが違います(期待: ${expected} / 実際: ${actual})。内容が変わった可能性があります`,
    );
  }
}
