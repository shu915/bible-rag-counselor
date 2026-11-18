import { describe, expect, it } from "vitest";
import { OpenRouterError } from "./openrouter";
import {
  clientIp,
  failedBeforeReachingAi,
  hashIp,
  normalizeIp,
  readRateLimitConfig,
  reserve,
  type RateLimitConfig,
} from "./rate-limit";
import type { Queryable } from "./search-passages";

// 偽の DB。SQL の文面で見分けて、「IP ごとの、日ごとの回数」を、メモリの中で数える。
// (SQL そのものの動き — 上限での停止・戻し・上限 0 — は、実際の Postgres で確かめた。ここでは、呼び出しの流れを見る)
function fakeDb(initial: Record<string, number> = {}): {
  db: Queryable;
  counts: Map<string, number>;
  calls: { text: string; values: unknown[] }[];
} {
  const counts = new Map(Object.entries(initial));
  const calls: { text: string; values: unknown[] }[] = [];
  const db: Queryable = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.startsWith("DELETE")) return { rows: [] };
      if (text.includes("SUM(count)")) {
        return { rows: [{ total: [...counts.values()].reduce((a, b) => a + b, 0) }] };
      }
      if (text.startsWith("INSERT")) {
        const [ipHash, limit] = values as [string, number];
        const current = counts.get(ipHash) ?? 0;
        if (limit < 1 || current >= limit) return { rows: [] };
        counts.set(ipHash, current + 1);
        return { rows: [{ day: "2026-11-18" }] };
      }
      if (text.startsWith("UPDATE")) {
        const [ipHash] = values as [string];
        counts.set(ipHash, Math.max((counts.get(ipHash) ?? 0) - 1, 0));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return { db, counts, calls };
}

const config: RateLimitConfig = { perIpPerDay: 2, globalPerDay: 5 };

describe("reserve", () => {
  it("IP ごとの上限まで取れて、超えたら、scope が ip で断る", async () => {
    const { db } = fakeDb();
    expect((await reserve(db, "a", config)).ok).toBe(true);
    expect((await reserve(db, "a", config)).ok).toBe(true);
    expect(await reserve(db, "a", config)).toEqual({ ok: false, scope: "ip" });
    // 別の IP は、別の枠
    expect((await reserve(db, "b", config)).ok).toBe(true);
  });

  it("全体の上限に達したら、scope が global で断る(IP の枠が残っていても)", async () => {
    const { db } = fakeDb({ x: 3, y: 2 });
    expect(await reserve(db, "new-ip", config)).toEqual({ ok: false, scope: "global" });
  });

  it("release で、枠を戻せる(AI に届かなかったとき)。0 より下には、ならない", async () => {
    const { db, counts } = fakeDb();
    const reservation = await reserve(db, "a", config);
    if (!reservation.ok) throw new Error("取れるはず");
    expect(counts.get("a")).toBe(1);
    await reservation.release();
    expect(counts.get("a")).toBe(0);
    await reservation.release();
    expect(counts.get("a")).toBe(0);
    // 戻したあとは、また取れる
    expect((await reserve(db, "a", config)).ok).toBe(true);
  });

  it("上限が 0 なら、だれも取れない", async () => {
    const { db } = fakeDb();
    expect(await reserve(db, "a", { perIpPerDay: 0, globalPerDay: 5 })).toEqual({
      ok: false,
      scope: "ip",
    });
  });

  it("記録するのは、IP のハッシュ・日付・回数だけ。悩みの内容は、問い合わせに現れない", async () => {
    const { db, calls } = fakeDb();
    await reserve(db, "hashed-ip", config);
    for (const call of calls) {
      for (const value of call.values) {
        // 問い合わせに渡る値は、ハッシュ・上限(数)・日付だけ
        expect(["string", "number"]).toContain(typeof value);
      }
    }
    expect(calls.some((c) => c.text.startsWith("DELETE"))).toBe(true);
  });
});

describe("hashIp", () => {
  it("同じ IP・同じ salt なら同じ値。IP か salt が違えば、違う値。元の IP は、含まれない", () => {
    const env = { RATE_LIMIT_SALT: "s1" };
    const a = hashIp("203.0.113.7", env);
    expect(a).toBe(hashIp("203.0.113.7", env));
    expect(a).not.toBe(hashIp("203.0.113.8", env));
    expect(a).not.toBe(hashIp("203.0.113.7", { RATE_LIMIT_SALT: "s2" }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203.0.113.7");
  });

  it("本番で salt がなければ、止まる。開発では、開発用の値で動く", () => {
    expect(() => hashIp("1.2.3.4", { NODE_ENV: "production" })).toThrow("RATE_LIMIT_SALT");
    expect(hashIp("1.2.3.4", { NODE_ENV: "development" })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("clientIp", () => {
  const vercel = { VERCEL: "1" };

  it("Vercel のときだけ、x-forwarded-for の先頭(クライアントの IP)を使う。なければ x-real-ip、それもなければ unknown", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), vercel)).toBe(
      "203.0.113.7",
    );
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.2" }), vercel)).toBe("198.51.100.2");
    expect(clientIp(new Headers(), vercel)).toBe("unknown");
  });

  it("Vercel 以外では、x-forwarded-for は、偽装できるので、信頼しない(全員が unknown)", () => {
    const spoofed = new Headers({ "x-forwarded-for": "203.0.113.7" });
    expect(clientIp(spoofed, {})).toBe("unknown");
    expect(clientIp(spoofed, { NODE_ENV: "production" })).toBe("unknown");
  });
});

describe("normalizeIp(IPv6 は /64 に丸める)", () => {
  it("同じ /64 の中の IP は、同じキーになる。別の /64 は、別のキー", () => {
    const a = normalizeIp("2001:db8:abcd:12:1:2:3:4");
    expect(a).toBe("2001:0db8:abcd:0012::/64");
    expect(normalizeIp("2001:db8:abcd:12:ffff:eeee:dddd:cccc")).toBe(a);
    expect(normalizeIp("2001:db8:abcd:12::1")).toBe(a);
    expect(normalizeIp("2001:db8:abcd:13::1")).not.toBe(a);
  });

  it("省略記法(::)も、展開してから丸める", () => {
    expect(normalizeIp("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(normalizeIp("::1")).toBe("0000:0000:0000:0000::/64");
  });

  it("IPv4 は、そのまま。IPv4 射影・ポート・角括弧・ゾーン ID は、取り除く", () => {
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:0db8:0000:0000::/64");
    expect(normalizeIp("fe80::1%en0")).toBe("fe80:0000:0000:0000::/64");
  });

  it("形が正しくなければ unknown", () => {
    for (const bad of ["", "abc", "999.1.1.1", "1:2:3", "1::2::3", "gggg::1", "1.2.3"]) {
      expect(normalizeIp(bad)).toBe("unknown");
    }
  });
});

describe("readRateLimitConfig", () => {
  it("本番の既定は、IP 5回・全体 100回。開発の既定は、事実上、制限なし", () => {
    expect(readRateLimitConfig({ NODE_ENV: "production" })).toEqual({
      perIpPerDay: 5,
      globalPerDay: 100,
    });
    expect(readRateLimitConfig({ NODE_ENV: "development" }).perIpPerDay).toBeGreaterThan(100);
  });

  it("環境変数で変えられる。0 も指定できる(受け付けを止める)", () => {
    expect(
      readRateLimitConfig({
        NODE_ENV: "production",
        RATE_LIMIT_PER_IP_PER_DAY: "8",
        RATE_LIMIT_GLOBAL_PER_DAY: "0",
      }),
    ).toEqual({ perIpPerDay: 8, globalPerDay: 0 });
  });

  it("数でない・負の値は、黙って無制限にせず、止まる", () => {
    expect(() => readRateLimitConfig({ RATE_LIMIT_PER_IP_PER_DAY: "たくさん" })).toThrow();
    expect(() => readRateLimitConfig({ RATE_LIMIT_GLOBAL_PER_DAY: "-1" })).toThrow();
    expect(() => readRateLimitConfig({ RATE_LIMIT_PER_IP_PER_DAY: "1.5" })).toThrow();
  });
});

describe("failedBeforeReachingAi(数えるか・数えないか)", () => {
  const error = (kind: ConstructorParameters<typeof OpenRouterError>[2], status?: number) =>
    new OpenRouterError("x", status, kind);

  it("設定の誤り・接続できない・HTTP エラー(402・403・429・5xx)は、AI に届いていない → 数えない", () => {
    expect(failedBeforeReachingAi(error("config"), 0)).toBe(true);
    expect(failedBeforeReachingAi(error("network"), 0)).toBe(true);
    for (const status of [402, 403, 429, 500, 503]) {
      expect(failedBeforeReachingAi(error("http", status), 0)).toBe(true);
    }
  });

  it("1回の待ち時間の超過(timeout)と、全体の締め切りの超過(deadline)は、分からない → 数える", () => {
    expect(failedBeforeReachingAi(error("timeout"), 0)).toBe(false);
    expect(failedBeforeReachingAi(error("deadline"), 0)).toBe(false);
  });

  it("AI が答えたが使えなかった(本文が空・形が違う)・そのほかの失敗は、数える", () => {
    expect(failedBeforeReachingAi(error("response"), 0)).toBe(false);
    expect(failedBeforeReachingAi(new Error("解説の検証に失敗"), 0)).toBe(false);
    expect(failedBeforeReachingAi("文字列", 0)).toBe(false);
  });

  it("この相談の中で、AI が1回でも答えていれば、HTTP エラーでも、戻さない(数える)", () => {
    // 書き換えと選択が成功(費用がかかった)あと、最後の生成が 503 で失敗した、など
    expect(failedBeforeReachingAi(error("http", 503), 2)).toBe(false);
    expect(failedBeforeReachingAi(error("network"), 1)).toBe(false);
    expect(failedBeforeReachingAi(error("config"), 1)).toBe(false);
  });
});
