// 回数制限(docs/rate-limit.md)。ログインなしで誰でも使えるので、費用を守るために、AI を呼ぶ前に数える。
// 1. IP 単位の、1日の回数(既定 5。環境変数で変える)
// 2. 全体の、1日の回数(環境変数で変える)
// (3. OpenRouter 側の、月の上限は、キーの設定。402・403 は、route.ts で「今月の利用は終了」に変える)
// **記録は「IP のハッシュ・日付・回数」だけ**。IP は生で持たない。悩みの内容は、一切入れない。
// 数える・数えない: AI に届かなかった失敗は数えない(release で戻す)。答えたあとの失敗は数える。
// 危機の固定画面(AI を呼ばない)は、数えず、上限でも止めない(呼び出し側で、この関数の前に返す)。
import { createHmac } from "node:crypto";
import { OpenRouterError } from "./openrouter";
import type { Queryable } from "./search-passages";

export interface RateLimitConfig {
  perIpPerDay: number;
  globalPerDay: number;
}

// 環境変数から、上限を読む。未設定のときの既定:
// - 本番: IP あたり 5回 / 全体 100回(月 $5 の上限に合わせて、運用で調整する)
// - 開発: 事実上、制限なし(開発で、何度も試すため)
export function readRateLimitConfig(
  env: Record<string, string | undefined> = process.env,
): RateLimitConfig {
  const production = env.NODE_ENV === "production";
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    // 数でない・負の値は、設定の誤り。黙って無制限にならないよう、止める
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`${name} は、0以上の整数にしてください`);
    return value;
  };
  return {
    perIpPerDay: read("RATE_LIMIT_PER_IP_PER_DAY", production ? 5 : 1_000),
    globalPerDay: read("RATE_LIMIT_GLOBAL_PER_DAY", production ? 100 : 10_000),
  };
}

// IP を、元に戻せない形(HMAC-SHA256)にする。秘密の値(salt)は、環境変数 RATE_LIMIT_SALT。
// 本番で salt がなければ、止める(IP は、数が少ないので、salt なしのハッシュは、総当たりで元に戻せてしまう)
export function hashIp(ip: string, env: Record<string, string | undefined> = process.env): string {
  const salt = env.RATE_LIMIT_SALT;
  if (!salt && env.NODE_ENV === "production") {
    throw new Error("RATE_LIMIT_SALT が未設定です(本番では必須)");
  }
  return createHmac("sha256", salt || "development-only-salt")
    .update(ip)
    .digest("hex");
}

// IPv6 を、8つのグループ(各4桁の16進数)に展開する。形が正しくなければ undefined
function expandIpv6(value: string): string[] | undefined {
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const filler = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 ? filler < 1 : head.length !== 8) return undefined;
  const groups = [...head, ...Array<string>(filler).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  return groups.map((g) => g.toLowerCase().padStart(4, "0"));
}

// IP を、数える単位(キー)にそろえる。
// - **IPv6 は、/64 に丸める**: 家庭や携帯の回線は、/64 の中で、IP を自由に変えられる。丸めないと、IP ごとの枠が、実質、無制限になる
// - IPv4 射影の IPv6(::ffff:1.2.3.4)は、IPv4 として扱う。ポート番号・ゾーン ID・角括弧は、除く
// - 形が正しくなければ "unknown"(全員が同じ枠を共有する。きびしい側に倒す)
export function normalizeIp(ip: string): string {
  let value = ip
    .trim()
    .replace(/^\[(.*)\](?::\d+)?$/, "$1")
    .replace(/%.*$/, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped?.[1]) value = mapped[1];
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value);
  if (withPort?.[1]) value = withPort[1];

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((n) => Number(n) <= 255) ? value : "unknown";
  }
  const groups = expandIpv6(value);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : "unknown";
}

// リクエストから、IP を取る。
// **x-forwarded-for は、Vercel(環境変数 VERCEL がある)のときだけ信頼する**。Vercel は、クライアントが付けた値を上書きする。
// それ以外(ローカル・別の置き場)では、クライアントが自由に付けられる(偽装して、枠を回避できる)ので、信頼せず、
// 全員を "unknown" にする(同じ枠を共有する。きびしい側に倒す)
export function clientIp(
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!env.VERCEL) return "unknown";
  const raw =
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim();
  return raw ? normalizeIp(raw) : "unknown";
}

// 日本時間の「今日」(SQL の中で計算する。サーバーの時計と時刻のずれに、左右されない)
const TODAY_JST = "(now() AT TIME ZONE 'Asia/Tokyo')::date";

export type Reservation =
  { ok: true; release: () => Promise<void> } | { ok: false; scope: "ip" | "global" };

// 1回ぶんの枠を取る(AI を呼ぶ前に)。取れたら、release で戻せる(AI に届かなかったとき)
export async function reserve(
  db: Queryable,
  ipHash: string,
  config: RateLimitConfig,
): Promise<Reservation> {
  // 古い行を消す(数日分だけ持つ。記録を、必要以上に持たない)
  await db.query(`DELETE FROM rate_limits WHERE day < ${TODAY_JST} - 7`);

  // 全体の上限。(確認と取得が、別の問い合わせなので、同時に来ると、少しだけ超えうる。費用の上限(月 $5)が、本当の天井)
  const total = await db.query(
    `SELECT COALESCE(SUM(count), 0)::int AS total FROM rate_limits WHERE day = ${TODAY_JST}`,
  );
  const used = Number((total.rows[0] as { total?: unknown } | undefined)?.total ?? 0);
  if (used >= config.globalPerDay) return { ok: false, scope: "global" };

  // IP ごとの上限。1つの SQL で、「上限未満なら +1」を、まとめて行う(同時に来ても、IP ごとの上限は、超えない)
  const result = await db.query(
    `INSERT INTO rate_limits (ip_hash, day, count)
     SELECT $1, ${TODAY_JST}, 1 WHERE $2::int >= 1
     ON CONFLICT (ip_hash, day) DO UPDATE SET count = rate_limits.count + 1
       WHERE rate_limits.count < $2::int
     RETURNING day::text AS day`,
    [ipHash, config.perIpPerDay],
  );
  const row = result.rows[0] as { day?: unknown } | undefined;
  if (!row || typeof row.day !== "string") return { ok: false, scope: "ip" };

  const day = row.day;
  return {
    ok: true,
    // 枠を戻す(日付は、取ったときのもの。日付をまたいでも、取った日の枠を戻す)
    release: async () => {
      await db.query(
        "UPDATE rate_limits SET count = GREATEST(count - 1, 0) WHERE ip_hash = $1 AND day = $2::date",
        [ipHash, day],
      );
    },
  };
}

// 失敗が、「AI に届かなかった」ものか(true なら、数えない。枠を戻す)。
// - **この相談の中で、AI が1回でも答えていれば(successfulCalls > 0)、戻さない**。途中まで成功して(費用がかかって)、
//   最後の生成が失敗したときに、全部戻すと、生成が不安定な間、枠を減らさずに、実費をかけて使えてしまう
// - 設定の誤り・接続できない・相手が HTTP エラーを返した(402・403・429・5xx など)→ 届いていない
// - 1回の待ち時間の超過・全体の締め切りの超過 → 分からない(数える。安全側。届いて、生成中かもしれない)
// - AI が答えたが、使えなかった(本文が空・形が違う)・解説の検証に失敗 → 答えている(数える)
// - それ以外(DB の失敗など)→ 数える(AI を呼んだあとに起きる失敗が多い)
export function failedBeforeReachingAi(error: unknown, successfulCalls: number): boolean {
  if (successfulCalls > 0) return false;
  if (error instanceof OpenRouterError) {
    return error.kind === "config" || error.kind === "network" || error.kind === "http";
  }
  return false;
}
