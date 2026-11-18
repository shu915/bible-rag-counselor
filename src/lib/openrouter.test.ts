import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHAT_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  OpenRouterError,
  chatText,
  embedTexts,
  withAiCallCounter,
} from "./openrouter";

// 本物の OpenRouter は呼ばない(fetch を差し替える)。実際に呼ぶテストは openrouter.live.test.ts

const vector = (value: number): number[] =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, () => value);
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("embedTexts(リクエスト)", () => {
  it("モデル・入力・data_collection: deny を送り、キーを Authorization に付ける", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ embedding: vector(0.1), index: 0 }] }));
    await embedTexts(["こんにちは"]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: EMBEDDING_MODEL,
      input: ["こんにちは"],
      encoding_format: "float",
      provider: { data_collection: "deny" },
    });
  });

  it("空の配列は、通信せずに空の配列を返す", async () => {
    expect(await embedTexts([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("空の文字列は、通信せずに断る", async () => {
    await expect(embedTexts(["あ", "  "])).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("キーが無いときは、通信せずに止まる", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    await expect(embedTexts(["あ"])).rejects.toThrow("OPENROUTER_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("embedTexts(返答)", () => {
  it("index の順に並べ直して、入力と同じ順序で返す", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { embedding: vector(2), index: 1 },
          { embedding: vector(1), index: 0 },
        ],
      }),
    );
    const result = await embedTexts(["a", "b"]);
    expect(result[0][0]).toBe(1);
    expect(result[1][0]).toBe(2);
  });

  it("件数が入力と違えば、止まる", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ embedding: vector(1), index: 0 }] }));
    await expect(embedTexts(["a", "b"])).rejects.toThrow("件数");
  });

  it("次元数が違えば、止まる(DB の vector(1536) に入らない)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ embedding: [0.1, 0.2], index: 0 }] }));
    await expect(embedTexts(["a"])).rejects.toThrow("次元数");
  });

  it("返答の形が違えば、止まる", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: "x" }));
    await expect(embedTexts(["a"])).rejects.toThrow(OpenRouterError);
  });
});

describe("embedTexts(失敗とやり直し)", () => {
  it("429 は、やり直して成功する", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "busy" }, 429))
      .mockResolvedValueOnce(jsonResponse({ data: [{ embedding: vector(1), index: 0 }] }));
    const result = await embedTexts(["a"], { retryBaseDelayMs: 0 });
    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("接続の失敗も、やり直す", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ data: [{ embedding: vector(1), index: 0 }] }));
    await embedTexts(["a"], { retryBaseDelayMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("3回失敗したら、状態つきの例外にする", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "down" }, 503));
    const error = await embedTexts(["a"], { retryBaseDelayMs: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRouterError);
    expect((error as OpenRouterError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("402(上限に達した)や 401(キーが違う)は、やり直さない", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "limit" }, 402));
    await expect(embedTexts(["a"], { retryBaseDelayMs: 0 })).rejects.toMatchObject({ status: 402 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("embedTexts(入力を出さない)", () => {
  const secret = "上司に言えない秘密の悩み";

  it("失敗の例外に、入力の中身もキーも含まれない", async () => {
    fetchMock.mockResolvedValue(
      // 相手が、入力を返答に含めて返してきた場合でも、メッセージには出さない
      jsonResponse({ error: { message: `bad input: ${secret}` } }, 400),
    );
    const error = await embedTexts([secret], { retryBaseDelayMs: 0 }).catch((e: unknown) => e);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("test-key");
  });

  it("接続の失敗の例外にも、入力の中身もキーも含まれない", async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed ${secret} test-key`));
    const error = await embedTexts([secret], { retryBaseDelayMs: 0 }).catch((e: unknown) => e);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("test-key");
  });
});

describe("chatText(リクエスト)", () => {
  const okBody = (content: string | null, finish = "stop") => ({
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  });

  it("既定のモデル・メッセージ・推論の量・data_collection: deny を送る", async () => {
    vi.stubEnv("OPENROUTER_CHAT_MODEL", "");
    fetchMock.mockResolvedValueOnce(jsonResponse(okBody("こんにちは")));
    const result = await chatText({
      system: "あなたは助手です",
      user: "悩み",
      maxTokens: 200,
      temperature: 0.2,
      reasoningEffort: "minimal",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: DEFAULT_CHAT_MODEL,
      messages: [
        { role: "system", content: "あなたは助手です" },
        { role: "user", content: "悩み" },
      ],
      max_tokens: 200,
      temperature: 0.2,
      reasoning: { effort: "minimal" },
      provider: { data_collection: "deny" },
    });
    expect(result).toEqual({
      text: "こんにちは",
      usage: { promptTokens: 120, completionTokens: 30 },
    });
  });

  it("OPENROUTER_CHAT_MODEL があれば、そのモデルを使う", async () => {
    vi.stubEnv("OPENROUTER_CHAT_MODEL", "example/other-model");
    fetchMock.mockResolvedValueOnce(jsonResponse(okBody("a")));
    await chatText({ user: "x", maxTokens: 10 });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe("example/other-model");
  });

  it("purpose が writing のときだけ、OPENROUTER_WRITING_MODEL を使う。なければ、chat のモデル", async () => {
    const sentModel = (): string =>
      JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).model;
    const okResponse = () => jsonResponse(okBody("a"));
    vi.stubEnv("OPENROUTER_CHAT_MODEL", "example/light");
    vi.stubEnv("OPENROUTER_WRITING_MODEL", "example/writer");

    fetchMock.mockImplementation(() => Promise.resolve(okResponse()));
    await chatText({ user: "x", maxTokens: 10, purpose: "writing" });
    expect(sentModel()).toBe("example/writer");

    // 軽い仕事(purpose なし)は、WRITING のモデルを使わない
    await chatText({ user: "x", maxTokens: 10 });
    expect(sentModel()).toBe("example/light");

    // WRITING が未設定なら、writing でも chat のモデル
    vi.stubEnv("OPENROUTER_WRITING_MODEL", "");
    await chatText({ user: "x", maxTokens: 10, purpose: "writing" });
    expect(sentModel()).toBe("example/light");

    // purpose は、API には送らない
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).not.toHaveProperty(
      "purpose",
    );
  });

  it("system と temperature と推論の指定がなければ、送らない", async () => {
    vi.stubEnv("OPENROUTER_CHAT_MODEL", "");
    fetchMock.mockResolvedValueOnce(jsonResponse(okBody("a")));
    await chatText({ user: "x", maxTokens: 10 });
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sent.messages).toEqual([{ role: "user", content: "x" }]);
    expect(sent).not.toHaveProperty("temperature");
    expect(sent).not.toHaveProperty("reasoning");
  });
});

describe("chatText(返答と失敗)", () => {
  it("本文が空(推論で出力の上限を使い切った)なら、finish_reason つきで止まる", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: null }, finish_reason: "length" }] }),
    );
    await expect(chatText({ user: "x", maxTokens: 10 })).rejects.toThrow("length");
  });

  it("返答の形が違えば、止まる", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }));
    await expect(chatText({ user: "x", maxTokens: 10 })).rejects.toThrow(OpenRouterError);
  });

  it("429 はやり直し、402 はやり直さない", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    await chatText({ user: "x", maxTokens: 10 }, { retryBaseDelayMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({}, 402));
    await expect(
      chatText({ user: "x", maxTokens: 10 }, { retryBaseDelayMs: 0 }),
    ).rejects.toMatchObject({
      status: 402,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("相談文も返答の本文も、例外に含まれない", async () => {
    const secret = "上司に言えない秘密の悩み";
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: `bad: ${secret}` } }, 400));
    const error = await chatText({ user: secret, maxTokens: 10 }).catch((e: unknown) => e);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("test-key");
  });
});

describe("chat は、接続の失敗・タイムアウトで再送しない(二重課金を避ける)", () => {
  const ok = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };

  it("接続の失敗では、1回だけ呼んで、止まる", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(chatText({ user: "x", maxTokens: 10 }, { retryBaseDelayMs: 0 })).rejects.toThrow(
      OpenRouterError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("タイムアウトでも、1回だけ呼んで、止まる", async () => {
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(chatText({ user: "x", maxTokens: 10 }, { retryBaseDelayMs: 0 })).rejects.toThrow(
      OpenRouterError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("呼び出しには、タイムアウトの合図(signal)を付ける。既定は、ベクトル化(60秒)より短い", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    // Response の本文は1回しか読めないので、呼び出しのたびに、新しく作って返す
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(ok)));
    await chatText({ user: "x", maxTokens: 10 });
    await chatText({ user: "x", maxTokens: 10 }, { timeoutMs: 5000 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ embedding: vector(1), index: 0 }] }));
    await embedTexts(["a"]);
    expect(spy.mock.calls.map((call) => call[0])).toEqual([30_000, 5000, 60_000]);
    spy.mockRestore();
  });

  it("429 や 5xx は、これまでどおり、やり直す", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503)).mockResolvedValueOnce(jsonResponse(ok));
    await chatText({ user: "x", maxTokens: 10 }, { retryBaseDelayMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("明示すれば、接続の失敗でも、やり直せる", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(ok));
    await chatText(
      { user: "x", maxTokens: 10 },
      { retryBaseDelayMs: 0, retryOnNetworkError: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("chat の 5xx の再送は、429 と 503 だけ(二重課金を避ける)", () => {
  const ok = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };

  it("502・504 は、再送しない。503 は、再送する", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 502));
    await expect(
      chatText({ user: "x", maxTokens: 10 }, { retryBaseDelayMs: 0 }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503)).mockResolvedValueOnce(jsonResponse(ok));
    await chatText({ user: "x", maxTokens: 10 }, { retryBaseDelayMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ベクトル化は、これまでどおり、5xx 全般をやり直す", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(jsonResponse({ data: [{ embedding: vector(1), index: 0 }] }));
    await embedTexts(["a"], { retryBaseDelayMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("相談1件ぶんの全体の締め切り(signal)", () => {
  const ok = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };

  it("締め切りを過ぎていたら、呼ばずに止まる", async () => {
    await expect(
      chatText({ user: "x", maxTokens: 10 }, { signal: AbortSignal.abort() }),
    ).rejects.toThrow("締め切り");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("やり直しの待ちの途中で締め切りが来たら、待たずに止まる", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    const startedAt = Date.now();
    await expect(
      chatText(
        { user: "x", maxTokens: 10 },
        { retryBaseDelayMs: 10_000, signal: AbortSignal.timeout(50) },
      ),
    ).rejects.toThrow(OpenRouterError);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("実行中の呼び出しにも、締め切りの合図が伝わる", async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("a", "AbortError")),
          );
        }),
    );
    const error = await chatText(
      { user: "x", maxTokens: 10 },
      { signal: AbortSignal.timeout(30) },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRouterError);
    expect(String(error)).toContain("締め切り");
  });

  it("本文を読んでいる最中に締め切りが来たら、「JSON ではない」でなく、締め切りとして伝える", async () => {
    const controller = new AbortController();
    const response = jsonResponse(ok);
    // 本文を読もうとした時点で、締め切りが来ていて、読み込みが失敗する状況
    vi.spyOn(response, "json").mockImplementation(() => {
      controller.abort();
      return Promise.reject(new TypeError("aborted"));
    });
    fetchMock.mockResolvedValue(response);
    const error = await chatText({ user: "x", maxTokens: 10 }, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenRouterError);
    expect(String(error)).toContain("締め切り");
  });

  it("締め切りの合図を渡さなければ、これまでどおり動く", async () => {
    fetchMock.mockResolvedValue(jsonResponse(ok));
    expect((await chatText({ user: "x", maxTokens: 10 })).text).toBe("ok");
  });
});

describe("失敗の種類(kind): 回数制限で、AI に届いたかを区別する", () => {
  const kindOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
    const error = await run().catch((e: unknown) => e);
    return error instanceof OpenRouterError ? error.kind : undefined;
  };

  it("キーがない → config / 接続できない → network / HTTP エラー → http", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(await kindOf(() => chatText({ user: "x", maxTokens: 10 }))).toBe("config");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");

    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await kindOf(() => chatText({ user: "x", maxTokens: 10 }))).toBe("network");

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({}, 403));
    expect(await kindOf(() => chatText({ user: "x", maxTokens: 10 }))).toBe("http");
  });

  it("全体の締め切りを過ぎた → deadline(届いたか分からない)", async () => {
    expect(
      await kindOf(() => chatText({ user: "x", maxTokens: 10 }, { signal: AbortSignal.abort() })),
    ).toBe("deadline");
  });

  it("答えは来たが使えない(本文が空・形が違う・JSON でない) → response(AI は答えている)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: null }, finish_reason: "length" }] }),
    );
    expect(await kindOf(() => chatText({ user: "x", maxTokens: 10 }))).toBe("response");

    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(new Response("<html>", { status: 200 })));
    expect(await kindOf(() => chatText({ user: "x", maxTokens: 10 }))).toBe("response");
  });
});

describe("1回の待ち時間の超過(timeout)は、接続の失敗(network)と区別する", () => {
  it("TimeoutError は kind が timeout(届いて、生成中かもしれない)。TypeError は network", async () => {
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const timeout = await chatText({ user: "x", maxTokens: 10 }).catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(OpenRouterError);
    expect((timeout as OpenRouterError).kind).toBe("timeout");

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const network = await chatText({ user: "x", maxTokens: 10 }).catch((e: unknown) => e);
    expect((network as OpenRouterError).kind).toBe("network");
  });

  it("全体の締め切りで止まったときは、timeout ではなく deadline", async () => {
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const error = await chatText(
      { user: "x", maxTokens: 10 },
      { signal: AbortSignal.abort() },
    ).catch((e: unknown) => e);
    expect((error as OpenRouterError).kind).toBe("deadline");
  });
});

describe("相談1件のあいだの、AI が答えた回数(withAiCallCounter)", () => {
  const ok = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };

  it("成功した呼び出し(JSON が返った)だけを数える。失敗は数えない", async () => {
    const counter = { successful: 0 };
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(ok)));
    await withAiCallCounter(counter, async () => {
      await chatText({ user: "x", maxTokens: 10 });
      await chatText({ user: "x", maxTokens: 10 });
    });
    expect(counter.successful).toBe(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    await withAiCallCounter(counter, () =>
      chatText({ user: "x", maxTokens: 10 }).catch(() => undefined),
    );
    expect(counter.successful).toBe(2);
  });

  it("途中まで成功して、最後に失敗しても、成功した分は数えてある", async () => {
    const counter = { successful: 0 };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(ok))
      .mockResolvedValueOnce(jsonResponse(ok))
      .mockResolvedValue(jsonResponse({}, 503));
    await withAiCallCounter(counter, async () => {
      await chatText({ user: "x", maxTokens: 10 });
      await chatText({ user: "x", maxTokens: 10 });
      await chatText({ user: "x", maxTokens: 10 }).catch(() => undefined);
    });
    expect(counter.successful).toBe(2);
  });

  it("別の相談の数と、混ざらない(同時に動いても、それぞれ別に数える)", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(ok)));
    const a = { successful: 0 };
    const b = { successful: 0 };
    await Promise.all([
      withAiCallCounter(a, async () => {
        await chatText({ user: "x", maxTokens: 10 });
      }),
      withAiCallCounter(b, async () => {
        await chatText({ user: "x", maxTokens: 10 });
        await chatText({ user: "x", maxTokens: 10 });
      }),
    ]);
    expect([a.successful, b.successful]).toEqual([1, 2]);
  });

  it("withAiCallCounter の外では、何も起きない", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(ok)));
    await expect(chatText({ user: "x", maxTokens: 10 })).resolves.toBeTruthy();
  });
});

describe("返答が JSON でないとき", () => {
  it("200 で HTML などが返っても、OpenRouterError にする(中身は出さない)", async () => {
    const html = "<html>混雑中 上司に言えない秘密の悩み</html>";
    fetchMock.mockResolvedValue(new Response(html, { status: 200 }));
    const error = await embedTexts(["a"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRouterError);
    expect(String(error)).not.toContain("上司に言えない秘密の悩み");

    const chatError = await chatText({ user: "x", maxTokens: 10 }).catch((e: unknown) => e);
    expect(chatError).toBeInstanceOf(OpenRouterError);
  });
});
