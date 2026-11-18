// 相談を受けて、聖書の3つの箇所と、解説と、結論を返す API。
// 入力の検証と、エラーの変換だけをここでやる(本体は src/lib/counsel-api.ts)。
// ユーザーの入力は繊細なので、入力も結果も、ログに出さない(エラーも、種類だけを返す)。
// 回数制限(docs/rate-limit.md): AI を呼ぶ前に、IP ごと・全体の、1日の枠を取る。AI に届かなかった失敗は、枠を戻す。
import { getDb } from "@/db/client";
import { counselRequestSchema, isCrisisInput, runCounsel } from "@/lib/counsel-api";
import { OpenRouterError, withAiCallCounter, type AiCallCounter } from "@/lib/openrouter";
import {
  clientIp,
  failedBeforeReachingAi,
  hashIp,
  readRateLimitConfig,
  reserve,
  type Reservation,
} from "@/lib/rate-limit";

// 相談1件ぶんの処理の、上限(秒)。書き換え・選択・生成の3回の AI 呼び出しで、約 15〜25 秒かかる
export const maxDuration = 60;
// 全体の締め切り(ミリ秒)。maxDuration より少し短くして、固定のエラーを返せるようにする
const DEADLINE_MS = 55_000;
// リクエストの本文の上限(文字)。500 字の入力に対して、十分に大きく、巨大な本文は、読まずに断る
const MAX_BODY_CHARS = 5_000;

const NO_STORE = { "Cache-Control": "no-store" };

type ApiError = "invalid" | "rate_limit" | "busy" | "limit" | "failed";

function errorResponse(error: ApiError, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

// 他のサイトからの送信(CSRF)で、訪問者のブラウザ経由で、他人の枠を使わせないための確認。
// Origin があるときは、このサイト自身(Host と同じ)のものだけを通す。Origin がない(curl など)ときは、通す
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    // Host ヘッダー(なければ、リクエストの URL の host)と、Origin の host が同じか
    const host = request.headers.get("host") ?? new URL(request.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  // 先に、軽い確認だけをする(本文は、まだ読まない)
  // text/plain などの「単純なリクエスト」は、他のサイトのフォームからも送れてしまうので、JSON だけを受ける
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse("invalid", 415);
  }
  if (!isSameOrigin(request)) return errorResponse("invalid", 403);
  // 巨大な本文は、読む前に、Content-Length で断る(読んだあとの長さの確認も、残す)
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_CHARS * 4) return errorResponse("invalid", 413);

  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return errorResponse("invalid", 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse("invalid", 400);
  }
  const parsed = counselRequestSchema.safeParse(body);
  if (!parsed.success) return errorResponse("invalid", 400);

  // 命の危険を示す入力は、数えず、上限でも止めずに、AI を呼ばない固定の画面を返す(回数制限より先)
  if (isCrisisInput(parsed.data)) {
    return Response.json({ kind: "crisis" }, { headers: NO_STORE });
  }

  // 回数制限: AI を呼ぶ前に、枠を取る。ここまでの失敗(設定・DB)は、AI に届いていないので、数えない
  let db: ReturnType<typeof getDb>;
  let reservation: Reservation;
  try {
    db = getDb();
    reservation = await reserve(db, hashIp(clientIp(request.headers)), readRateLimitConfig());
  } catch {
    return errorResponse("failed", 500);
  }
  if (!reservation.ok) {
    return reservation.scope === "ip"
      ? errorResponse("rate_limit", 429)
      : errorResponse("busy", 503);
  }

  // この相談の中で、AI が答えた回数を数える(途中まで成功して、最後に失敗したときに、枠を戻さないため)
  const counter: AiCallCounter = { successful: 0 };
  try {
    const result = await withAiCallCounter(counter, () =>
      runCounsel(db, parsed.data, AbortSignal.timeout(DEADLINE_MS)),
    );
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    // AI に届かなかった失敗は、数えない(枠を戻す)。ただし、1回でも AI が答えていれば、戻さない。
    // 答えたあとの失敗・1回の待ち時間や全体の締め切りの超過も、数える
    if (failedBeforeReachingAi(error, counter.successful)) {
      await reservation.release().catch(() => undefined);
    }
    // OpenRouter の月の上限(キーの上限)に達したときは、「今月の利用は終了」と伝える(402・403)。
    // 例外のメッセージには、入力や返答の中身が入らないが、念のため、ログには出さない
    if (error instanceof OpenRouterError && (error.status === 402 || error.status === 403)) {
      return errorResponse("limit", 503);
    }
    return errorResponse("failed", 500);
  }
}
