import { describe, expect, it } from "vitest";
import { assertChecksum, sha256Hex } from "./checksum";

const encode = (text: string) => new TextEncoder().encode(text);

// "abc" の SHA-256(標準的な既知の値)
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("チェックサム", () => {
  it("SHA-256 を16進数で返す", () => {
    expect(sha256Hex(encode("abc"))).toBe(ABC_SHA256);
  });

  it("一致していれば、何も起きない", () => {
    expect(() => assertChecksum(encode("abc"), ABC_SHA256, "テスト")).not.toThrow();
  });

  it("違っていれば、エラーにする(内容が書き換えられたとき)", () => {
    expect(() => assertChecksum(encode("abd"), ABC_SHA256, "テスト")).toThrow(
      "チェックサムが違います",
    );
  });

  it("エラーのメッセージに、データの中身は出さない", () => {
    const secret = "とても長い本文の内容";
    try {
      assertChecksum(encode(secret), ABC_SHA256, "テスト");
      expect.unreachable("エラーになるはず");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
