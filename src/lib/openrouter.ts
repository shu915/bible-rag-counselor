// OpenRouter を呼ぶ唯一のモジュール。
// **API キー(OPENROUTER_API_KEY)と、生成のモデル(OPENROUTER_CHAT_MODEL・OPENROUTER_WRITING_MODEL)を読むのは、このファイルだけ**にする
// (ほかから process.env で読まない)。
// ユーザーの入力は悩み・弱音・懺悔で、とても繊細。入力も返答も、ログにもエラーメッセージにも出さない。
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

// エンベディングのモデル。**環境変数にしない**(変えると、DB の全件を入れ直す必要がある)。
// 文書側(DB 投入)と検索側(ユーザーの質問)で、必ず同じモデルを使うため、ここに1つだけ置く。
// 次元数は、DB の `embedding vector(1536)` と一致していなければならない
export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

// 生成のモデル。変えても DB のデータに影響しないので、環境変数(OPENROUTER_CHAT_MODEL)で入れ替えられる
export const DEFAULT_CHAT_MODEL = "google/gemini-4-hydrogen";

const BASE_URL = "https://openrouter.ai/api/v1";
// 1回の呼び出しの待ち時間の上限。ベクトル化は 60 秒。文章の生成(chat)は、相談1件で何度も呼ぶので、短く 30 秒にする
const REQUEST_TIMEOUT_MS = 60_000;
const CHAT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

// 失敗の種類。回数制限で、「AI に届かなかった失敗は数えず、答えたあとの失敗は数える」を決めるために、区別する
// - config: 設定の誤り(キーがない)。AI に届いていない
// - network: 接続できなかった。AI に届いていない
// - http: 相手が、エラーの HTTP 状態(402・403・429・5xx など)を返した。答えは、作られていない
// - deadline: 相談1件ぶんの全体の締め切りを過ぎた。届いたか、答えが作られたか、分からない(安全側で、数える)
// - timeout: 1回の呼び出しの待ち時間(chat は 30 秒)を過ぎた。**リクエストが届いて、AI が生成している最中でも起きる**ので、
//   「接続できなかった」ではない。deadline と同じく、分からない(安全側で、数える)
// - response: 答えは来たが、使えなかった(本文が空、形が違う、JSON でない)。AI は答えている(費用がかかっている)
export type OpenRouterErrorKind =
  "config" | "network" | "http" | "deadline" | "timeout" | "response";

// 相談1件のあいだに、AI が答えた(HTTP 200 で、JSON が返った)呼び出しの数を、数える。
// 回数制限で、「途中まで成功して(費用がかかって)、最後に失敗した」ときに、枠を戻さないために使う
// (戻すかどうかを、「最後の失敗の種類」だけで決めると、生成が不安定な間、枠を減らさずに、実費をかけて使えてしまう)。
// 引数で、何層にも渡さずに済むよう、AsyncLocalStorage で、リクエストの中に持たせる
export interface AiCallCounter {
  successful: number;
}
const counterStorage = new AsyncLocalStorage<AiCallCounter>();

// fn の中で起きる、OpenRouter の呼び出しの成功を、counter に数える
export function withAiCallCounter<T>(counter: AiCallCounter, fn: () => Promise<T>): Promise<T> {
  return counterStorage.run(counter, fn);
}

// 成功した呼び出しを、1つ数える(withAiCallCounter の中でだけ。外では、何もしない)
export function noteSuccessfulAiCall(): void {
  const counter = counterStorage.getStore();
  if (counter) counter.successful += 1;
}

// 呼び出しの失敗。メッセージには、入力や返答の中身を入れない(HTTP の状態だけ)
export class OpenRouterError extends Error {
  status: number | undefined;
  kind: OpenRouterErrorKind;

  constructor(message: string, status?: number, kind: OpenRouterErrorKind = "response") {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.kind = kind;
  }
}

export interface RequestOptions {
  // 失敗したときの、やり直しの待ち時間の基準(ミリ秒。回ごとに2倍になる)。テストで 0 にする
  retryBaseDelayMs?: number;
  // 1回の呼び出しの待ち時間の上限(ミリ秒)。ベクトル化は 60 秒、chat は 30 秒が既定
  timeoutMs?: number;
  // 接続の失敗・タイムアウトのときに、やり直すか。ベクトル化は既定で「やり直す」(安いので)。
  // chat は既定で「やり直さない」: タイムアウトしても、相手が処理を続けて、課金されていることがあり、
  // 再送すると、同じ相談で何回分も課金されるため
  retryOnNetworkError?: boolean;
  // 5xx のやり直しを、429 と 503 だけにする。chat は既定で true: 502・504 などは、生成が進んだあとで
  // 返ることがあり、再送すると二重課金になりうるため(429 は、処理されていないことが確実)
  conservativeRetry?: boolean;
  // 相談1件ぶんの、全体の締め切り。この合図が出たら、実行中の呼び出しも、やり直しの待ちも、すぐ止める
  // (呼び出し側が、AbortSignal.timeout(全体の上限) などを渡す)
  signal?: AbortSignal;
}

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key)
    throw new OpenRouterError("OPENROUTER_API_KEY が設定されていません", undefined, "config");
  return key;
}

// 混み合い(429)と、相手側の一時的な失敗(5xx)だけ、やり直す。お金や設定の問題(402・401・400 など)は、やり直さない。
// conservative のときは、429 と 503 だけ
function isRetryable(status: number, conservative: boolean): boolean {
  if (conservative) return status === 429 || status === 503;
  return status === 429 || (status >= 500 && status <= 599);
}

const DEADLINE_MESSAGE = "全体の締め切りを過ぎました";

// 待つ。締め切りの合図が出たら、待ちを打ち切って、止まる
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OpenRouterError(DEADLINE_MESSAGE, undefined, "deadline"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OpenRouterError(DEADLINE_MESSAGE, undefined, "deadline"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// POST して、返ってきた JSON(外から来るデータなので unknown)を返す。やり直しも、ここでやる。
// 入力(body)の中身を、例外やログに出さない
async function postJson(path: string, body: unknown, options: RequestOptions): Promise<unknown> {
  const key = getApiKey();
  const baseDelay = options.retryBaseDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const retryOnNetworkError = options.retryOnNetworkError ?? true;
  const conservative = options.conservativeRetry ?? false;

  for (let attempt = 1; ; attempt++) {
    // 全体の締め切りを過ぎていたら、呼ばない
    if (options.signal?.aborted) throw new OpenRouterError(DEADLINE_MESSAGE, undefined, "deadline");

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // 1回ぶんの上限と、全体の締め切りの、どちらかが先に来たら止まる
        signal: options.signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // 接続の失敗・タイムアウト。原因のエラーには、リクエストの中身が入りうるので、メッセージに使わない
      if (options.signal?.aborted)
        throw new OpenRouterError(DEADLINE_MESSAGE, undefined, "deadline");
      // 1回ぶんの待ち時間の超過(AbortSignal.timeout の TimeoutError)。届いていて、生成中かもしれない
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      if (timedOut && (!retryOnNetworkError || attempt >= MAX_ATTEMPTS)) {
        throw new OpenRouterError(
          "OpenRouter の応答が、時間内に返りませんでした",
          undefined,
          "timeout",
        );
      }
      if (!retryOnNetworkError || attempt >= MAX_ATTEMPTS) {
        throw new OpenRouterError("OpenRouter に接続できませんでした", undefined, "network");
      }
      await sleep(baseDelay * 2 ** (attempt - 1), options.signal);
      continue;
    }

    if (!response.ok) {
      if (isRetryable(response.status, conservative) && attempt < MAX_ATTEMPTS) {
        await sleep(baseDelay * 2 ** (attempt - 1), options.signal);
        continue;
      }
      // 返答の本文は、メッセージに入れない(中身を出さないため)
      throw new OpenRouterError(
        `OpenRouter がエラーを返しました(HTTP ${response.status})`,
        response.status,
        "http",
      );
    }

    // 200 でも、本文が JSON でないことがある(混雑時の HTML など)。中身は、メッセージに入れない
    try {
      const json: unknown = await response.json();
      noteSuccessfulAiCall();
      return json;
    } catch {
      // 本文を読んでいる最中に、全体の締め切りが来たときは、「JSON ではない」ではなく、締め切りとして伝える
      if (options.signal?.aborted)
        throw new OpenRouterError(DEADLINE_MESSAGE, undefined, "deadline");
      throw new OpenRouterError("OpenRouter の返答が JSON ではありません", response.status);
    }
  }
}

// ---- エンベディング ----

// 返ってきた JSON は、外から来るデータなので、検証してから使う
const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number().int().optional(),
    }),
  ),
});

// 文字列の配列を、まとめてベクトルにする。返す順序は、入力と同じ。
// 文書側は100件ずつなどまとめて送り、検索側は1件だけ送る。
// モデルは EMBEDDING_MODEL に固定(文書側と検索側で、必ず同じモデルにするため、引数で変えられない)
export async function embedTexts(
  texts: readonly string[],
  options: RequestOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.some((text) => text.trim() === "")) {
    throw new RangeError("空の文字列は、エンベディングにできません");
  }

  const body = await postJson(
    "/embeddings",
    {
      model: EMBEDDING_MODEL,
      input: texts,
      encoding_format: "float",
      // 入力を、データを集める事業者に送らない
      provider: { data_collection: "deny" },
    },
    options,
  );
  return parseEmbeddings(body, texts.length, EMBEDDING_DIMENSIONS);
}

function parseEmbeddings(
  body: unknown,
  expectedCount: number,
  expectedDimensions: number,
): number[][] {
  const parsed = embeddingResponseSchema.safeParse(body);
  if (!parsed.success) throw new OpenRouterError("OpenRouter の返答の形式が想定と違います");

  const items = parsed.data.data;
  if (items.length !== expectedCount) {
    throw new OpenRouterError("OpenRouter の返答の件数が、入力と違います");
  }

  // 順序は保証されていると明記されていないので、index があれば、それで並べ直す
  const ordered = items.every((item) => item.index !== undefined)
    ? [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    : items;

  return ordered.map((item) => {
    if (item.embedding.length !== expectedDimensions) {
      throw new OpenRouterError(
        `ベクトルの次元数が違います(${item.embedding.length}。期待は ${expectedDimensions})`,
      );
    }
    return item.embedding;
  });
}

// ---- 文章の生成 ----

const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish() }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

export interface ChatRequest {
  system?: string;
  user: string;
  // 出力の上限。推論(reasoning)のトークンも、この中に数えられる(使い切ると、本文が空になる)
  maxTokens: number;
  temperature?: number;
  // 推論の量。短い書き換えなどは "minimal" にして、費用と時間を抑える
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  // "writing"(解説や結論を書く仕事)のときは、OPENROUTER_WRITING_MODEL があれば、それを使う。
  // 書き換えや選択のような軽い仕事は、指定しない(OPENROUTER_CHAT_MODEL)。
  // 書く仕事だけ、別のモデルにできる(迎合しにくいモデルを選ぶ、など)
  purpose?: "writing";
}

export interface ChatResult {
  text: string;
  // 費用の見積もり用。中身(本文)は含まない
  usage: { promptTokens: number | undefined; completionTokens: number | undefined };
}

// 文章を1回生成する。モデルは OPENROUTER_CHAT_MODEL(なければ既定値)。
// purpose が "writing" のときは、OPENROUTER_WRITING_MODEL があれば、それを優先する
export async function chatText(
  request: ChatRequest,
  options: RequestOptions = {},
): Promise<ChatResult> {
  const chatModel = process.env.OPENROUTER_CHAT_MODEL || DEFAULT_CHAT_MODEL;
  const model =
    request.purpose === "writing" ? process.env.OPENROUTER_WRITING_MODEL || chatModel : chatModel;
  const messages = [
    ...(request.system ? [{ role: "system", content: request.system }] : []),
    { role: "user", content: request.user },
  ];

  const body = await postJson(
    "/chat/completions",
    {
      model,
      messages,
      max_tokens: request.maxTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
      // 入力(悩み)を、データを集める事業者に送らない
      provider: { data_collection: "deny" },
    },
    // chat は、タイムアウトを短くして、接続の失敗・タイムアウトでは、再送しない(二重課金を避ける)
    {
      ...options,
      timeoutMs: options.timeoutMs ?? CHAT_TIMEOUT_MS,
      retryOnNetworkError: options.retryOnNetworkError ?? false,
      conservativeRetry: options.conservativeRetry ?? true,
    },
  );

  const parsed = chatResponseSchema.safeParse(body);
  if (!parsed.success) throw new OpenRouterError("OpenRouter の返答の形式が想定と違います");

  const choice = parsed.data.choices[0];
  const text = choice.message.content?.trim() ?? "";
  if (text === "") {
    // 推論で出力の上限を使い切ると、finish_reason が length で、本文が空になる
    throw new OpenRouterError(
      `OpenRouter の返答が空です(finish_reason: ${choice.finish_reason ?? "不明"})`,
    );
  }
  return {
    text,
    usage: {
      promptTokens: parsed.data.usage?.prompt_tokens,
      completionTokens: parsed.data.usage?.completion_tokens,
    },
  };
}
