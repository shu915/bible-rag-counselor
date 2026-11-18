// 検索で見つかった候補の聖書の箇所から、悩みに合う箇所を LLM に選ばせる。
// LLM に聖句は書かせない。LLM が返すのは「どの段落 id か」だけで、候補に含まれない id は捨てる
// (聖句は、必ず id で DB から取って表示する)。
// ユーザーの入力は繊細なので、入力も選んだ結果も、ログに出さない。
import { chatText } from "./openrouter";
import { MAX_QUERY_CHARS } from "./tokenizer";

export interface Candidate {
  id: string;
  // 本文(節をつないだもの)。長いときは、冒頭だけを LLM に渡す
  text: string;
}

const SYSTEM_PROMPT = `あなたは、悩みを抱えた人に、日本語口語訳聖書の箇所を紹介する案内役です。
ユーザーの悩みと、検索で見つかった候補の聖書の箇所(id と本文の冒頭)が与えられます。
悩みに最もよく寄り添う箇所を、候補の中から3つ選んでください。

選ぶ基準:
- 悩みの核心(気持ち・状況)に、直接答える、または寄り添う箇所を優先する
- 言葉や話題が似ているだけの箇所(例: 同じ「怒り」でも、神の怒りを語る箇所)は避ける
- 3つは、できるだけ別の角度から選ぶ(同じ内容の重複を避ける)
- 聖書にない現代の話題(AI、ビットコインなど)は、聖書にある主題に置き換えて考える
- ぴったりの箇所が候補になければ、最も近いものを選ぶ

出力は、選んだ箇所の id だけを、合う順に、1行に1つ、3行で書く。理由・番号・記号は付けない。
id は、候補に書かれているとおりに、一字も変えずに書く。`;

// 本文を、長すぎる場合は冒頭の maxChars 字に切る
export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

// LLM に渡す、候補の一覧
export function buildUserMessage(
  consultation: string,
  candidates: readonly Candidate[],
  maxChars: number,
): string {
  const list = candidates
    .map((c, i) => `[${i + 1}] id: ${c.id}\n${truncate(c.text, maxChars)}`)
    .join("\n\n");
  return `【悩み】\n${consultation}\n\n【候補】\n${list}`;
}

// 段落 id の形(例: Matt.6.25-34 / 1John.1.5-10 / Eccl.5.10)
const ID_PATTERN = /[0-9A-Za-z]+\.\d+\.\d+(?:-\d+)?/g;

// モデルの返答から、候補に含まれる id だけを、出てきた順に取り出す。
// 候補にない id(作り話や、書き間違い)と、重複は捨てる。多すぎるときは、先頭の k 件
export function parseSelection(
  text: string,
  candidateIds: ReadonlySet<string>,
  k: number,
): string[] {
  const picked: string[] = [];
  for (const match of text.matchAll(ID_PATTERN)) {
    const id = match[0];
    if (candidateIds.has(id) && !picked.includes(id)) picked.push(id);
    if (picked.length >= k) break;
  }
  return picked;
}

export interface SelectOptions {
  // 選ぶ件数(既定 3)
  count?: number;
  // 候補1件あたりの本文の長さの上限(既定 150字。人の目の比較で、300字と成績は同じで、費用が安い)。
  // 長い段落(詩篇など)で、入力が増えすぎるのを防ぐ
  maxCharsPerCandidate?: number;
  // 相談1件ぶんの全体の締め切り(OpenRouter の呼び出しと、やり直しの待ちを止める)
  signal?: AbortSignal;
}

// picked が count 件に満たなければ、候補を前から順に、重複しないように足して、count 件にする。
// `selectPassages` は「LLM の選択だけ」を返す(評価で、LLM の選択だけを測るため)。
// 作り話の id を捨てた・返答が崩れたなどで、count 件に満たないときは、**本番の呼び出し側が、この関数で補う**
// (候補は、関連性の高い順に、除外済みの集合から渡す。0件の画面にならないように)
export function fillSelection(
  picked: readonly string[],
  candidateIds: readonly string[],
  count: number,
): string[] {
  const result = [...picked];
  for (const id of candidateIds) {
    if (result.length >= count) break;
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

export interface SelectResult {
  // 選ばれた段落 id(候補に含まれるものだけ。count 件に満たないことがある)
  ids: string[];
  // 費用の見積もり用(本文は含まない)
  usage: { promptTokens: number | undefined; completionTokens: number | undefined };
}

// 悩みと候補から、悩みに合う箇所を count 件選ぶ
export async function selectPassages(
  consultation: string,
  candidates: readonly Candidate[],
  options: SelectOptions = {},
): Promise<SelectResult> {
  if (consultation.trim() === "") throw new RangeError("相談文が空です");
  if (consultation.length > MAX_QUERY_CHARS) {
    throw new RangeError(`入力が長すぎます(${MAX_QUERY_CHARS}字まで)`);
  }
  if (candidates.length === 0) throw new RangeError("候補がありません");

  const count = options.count ?? 3;
  const { text, usage } = await chatText(
    {
      system: SYSTEM_PROMPT,
      user: buildUserMessage(consultation, candidates, options.maxCharsPerCandidate ?? 150),
      // 推論(reasoning)のトークンも、この中に数えられるので、余裕を持たせる
      maxTokens: 4000,
      temperature: 0,
      reasoningEffort: "minimal",
    },
    options.signal ? { signal: options.signal } : {},
  );
  return {
    ids: parseSelection(text, new Set(candidates.map((c) => c.id)), count),
    usage,
  };
}
