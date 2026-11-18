import { beforeEach, describe, expect, it, vi } from "vitest";

// DB・AI は使わない(接続と、相談1件ぶんの処理を差し替える)
const mocks = vi.hoisted(() => ({ runCounsel: vi.fn(), reserve: vi.fn() }));
vi.mock("@/db/client", () => ({ getDb: () => ({ query: async () => ({ rows: [] }) }) }));
vi.mock("@/lib/counsel-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/counsel-api")>()),
  runCounsel: mocks.runCounsel,
}));

// 回数の枠だけを差し替える(IP の取り出し・ハッシュ・失敗の分類は、本物を使う)
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  reserve: mocks.reserve,
}));

import { OpenRouterError, noteSuccessfulAiCall } from "@/lib/openrouter";
import { POST } from "./route";

const post = (body: string, headers: Record<string, string> = {}): Request =>
  new Request("http://localhost/api/counsel", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", Host: "localhost", ...headers },
  });
const okBody = (consultation: string): string => JSON.stringify({ consultation });

const release = vi.fn(async () => undefined);

beforeEach(() => {
  mocks.runCounsel.mockReset();
  mocks.runCounsel.mockResolvedValue({
    kind: "ok",
    preface: null,
    passages: [],
    conclusion: "x",
    showHelp: false,
  });
  mocks.reserve.mockReset();
  release.mockClear();
  mocks.reserve.mockResolvedValue({ ok: true, release });
});

describe("POST /api/counsel(入力の検証)", () => {
  it("正しい入力なら、結果を返す。キャッシュはしない", async () => {
    const response = await POST(post(okBody("疲れた")));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ kind: "ok" });
    expect(mocks.runCounsel.mock.calls[0][1]).toMatchObject({ consultation: "疲れた" });
  });

  it("JSON でない・空・長すぎる・形が違う入力は、処理せずに 400", async () => {
    for (const body of [
      "これは JSON ではない",
      okBody("   "),
      okBody("あ".repeat(501)),
      JSON.stringify({ text: "疲れた" }),
      JSON.stringify({ consultation: 123 }),
    ]) {
      const response = await POST(post(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid" });
    }
    expect(mocks.runCounsel).not.toHaveBeenCalled();
  });

  it("巨大な本文は、読まずに 413", async () => {
    const response = await POST(post(okBody("あ".repeat(10_000))));
    expect(response.status).toBe(413);
    expect(mocks.runCounsel).not.toHaveBeenCalled();
  });

  it("JSON 以外の Content-Type(text/plain など)は、本文を読まずに 415", async () => {
    const response = await POST(post(okBody("疲れた"), { "Content-Type": "text/plain" }));
    expect(response.status).toBe(415);
    expect(mocks.runCounsel).not.toHaveBeenCalled();
  });

  it("他のサイトの Origin からの送信は、403。同じサイトの Origin と、Origin なしは通す", async () => {
    const foreign = await POST(post(okBody("疲れた"), { Origin: "https://evil.example" }));
    expect(foreign.status).toBe(403);
    const broken = await POST(post(okBody("疲れた"), { Origin: "not a url" }));
    expect(broken.status).toBe(403);
    expect(mocks.runCounsel).not.toHaveBeenCalled();

    const same = await POST(post(okBody("疲れた"), { Origin: "http://localhost" }));
    expect(same.status).toBe(200);
    expect((await POST(post(okBody("疲れた")))).status).toBe(200);
  });

  it("Content-Length が大きすぎるときは、本文を読まずに 413", async () => {
    const response = await POST(post(okBody("疲れた"), { "Content-Length": "999999" }));
    expect(response.status).toBe(413);
    expect(mocks.runCounsel).not.toHaveBeenCalled();
  });

  it("全体の締め切り(signal)を、処理に渡す", async () => {
    await POST(post(okBody("疲れた")));
    expect(mocks.runCounsel.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
  });
});

describe("POST /api/counsel(エラーの変換)", () => {
  it("OpenRouter の上限(402・403)は、「limit」(503)。入力の中身は、返さない", async () => {
    const secret = "上司に言えない秘密の悩み";
    for (const status of [402, 403]) {
      mocks.runCounsel.mockRejectedValueOnce(new OpenRouterError(`HTTP ${status}`, status));
      const response = await POST(post(okBody(secret)));
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: "limit" });
      expect(text).not.toContain(secret);
    }
  });

  it("そのほかの失敗は、「failed」(500)。例外の中身は、返さない", async () => {
    mocks.runCounsel.mockRejectedValueOnce(new Error("内部の詳細 上司に言えない秘密の悩み"));
    const response = await POST(post(okBody("疲れた")));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "failed" });
    expect(text).not.toContain("内部の詳細");
  });
});

describe("POST /api/counsel(回数制限)", () => {
  it("枠が取れたら、AI の処理に進む。成功なら、枠は戻さない", async () => {
    const response = await POST(post(okBody("疲れた")));
    expect(response.status).toBe(200);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it("IP を、ハッシュにして渡す(生の IP は、渡さない)。Vercel では、x-forwarded-for の先頭を使う", async () => {
    vi.stubEnv("VERCEL", "1");
    await POST(post(okBody("疲れた"), { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }));
    await POST(post(okBody("疲れた"), { "x-forwarded-for": "203.0.113.8" }));
    const [first, second] = mocks.reserve.mock.calls.map((call) => call[1] as string);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain("203.0.113.7");
    // IP が違えば、ハッシュも違う
    expect(first).not.toBe(second);
    vi.unstubAllEnvs();
  });

  it("Vercel 以外では、x-forwarded-for を信頼しない(偽装しても、同じ枠)", async () => {
    vi.stubEnv("VERCEL", "");
    await POST(post(okBody("疲れた"), { "x-forwarded-for": "203.0.113.7" }));
    await POST(post(okBody("疲れた"), { "x-forwarded-for": "198.51.100.1" }));
    const [first, second] = mocks.reserve.mock.calls.map((call) => call[1] as string);
    expect(first).toBe(second);
    vi.unstubAllEnvs();
  });

  it("IP の上限なら 429(rate_limit)、全体の上限なら 503(busy)。AI は呼ばない", async () => {
    mocks.reserve.mockResolvedValueOnce({ ok: false, scope: "ip" });
    const ip = await POST(post(okBody("疲れた")));
    expect(ip.status).toBe(429);
    expect(await ip.json()).toEqual({ error: "rate_limit" });

    mocks.reserve.mockResolvedValueOnce({ ok: false, scope: "global" });
    const global = await POST(post(okBody("疲れた")));
    expect(global.status).toBe(503);
    expect(await global.json()).toEqual({ error: "busy" });
    expect(mocks.runCounsel).not.toHaveBeenCalled();
  });

  it("命の危険を示す入力は、数えず、上限でも止めずに、固定の画面を返す", async () => {
    mocks.reserve.mockResolvedValue({ ok: false, scope: "ip" });
    const response = await POST(post(okBody("もう死にたい")));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "crisis" });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.runCounsel).not.toHaveBeenCalled();
  });

  it("「それでも続ける」なら、数える(AI を呼ぶので)", async () => {
    await POST(post(JSON.stringify({ consultation: "もう死にたい", continueAnyway: true })));
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.runCounsel).toHaveBeenCalledTimes(1);
  });

  it("AI に届かなかった失敗(接続・HTTP エラー・設定)は、枠を戻す", async () => {
    const unreached = [
      new OpenRouterError("x", undefined, "network"),
      new OpenRouterError("x", 503, "http"),
      new OpenRouterError("x", 403, "http"),
      new OpenRouterError("x", undefined, "config"),
    ];
    for (const error of unreached) {
      release.mockClear();
      mocks.runCounsel.mockRejectedValueOnce(error);
      await POST(post(okBody("疲れた")));
      expect(release).toHaveBeenCalledTimes(1);
    }
  });

  it("AI が答えたあとの失敗・1回の待ち時間と全体の締め切りの超過・そのほかの失敗は、枠を戻さない(数える)", async () => {
    const reached = [
      new OpenRouterError("x", undefined, "response"),
      new OpenRouterError("x", undefined, "deadline"),
      new OpenRouterError("x", undefined, "timeout"),
      new Error("解説の検証に失敗"),
    ];
    for (const error of reached) {
      release.mockClear();
      mocks.runCounsel.mockRejectedValueOnce(error);
      const response = await POST(post(okBody("疲れた")));
      expect(response.status).toBe(500);
      expect(release).not.toHaveBeenCalled();
    }
  });

  it("途中まで成功して(費用がかかって)、最後の呼び出しが失敗したときは、HTTP エラーでも、枠を戻さない", async () => {
    // 書き換えと選択が成功(2回)したあと、最後の生成が 503 で失敗した、という状況
    mocks.runCounsel.mockImplementationOnce(async () => {
      noteSuccessfulAiCall();
      noteSuccessfulAiCall();
      throw new OpenRouterError("x", 503, "http");
    });
    const response = await POST(post(okBody("疲れた")));
    expect(response.status).toBe(500);
    expect(release).not.toHaveBeenCalled();

    // 1回も成功していなければ、同じ失敗でも、戻す(次のリクエストは、前の数に影響されない)
    mocks.runCounsel.mockRejectedValueOnce(new OpenRouterError("x", 503, "http"));
    await POST(post(okBody("疲れた")));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("枠を取る処理が失敗したら(DB の失敗など)、500。AI は呼ばない", async () => {
    mocks.reserve.mockRejectedValueOnce(new Error("接続できない"));
    const response = await POST(post(okBody("疲れた")));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "failed" });
    expect(mocks.runCounsel).not.toHaveBeenCalled();
  });
});
