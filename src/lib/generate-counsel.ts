// 選んだ3件の聖書の箇所に、悩みに絡めた解説を書き、全体をまとめた結論を書く。
// LLM に聖句は書かせない。LLM が返すのは「どの段落 id について、どう解説するか」と結論だけで、
// 聖句の本文は、呼び出し側が id で DB から取って表示する。入力の候補にない id は捨てる。
// ユーザーの入力は繊細なので、入力も解説も、ログにも例外にも出さない。
// 規則(信仰を前提にしない、耐えろを勧めない、など)の根拠は docs/safety.md と eval/human-review.md。
import { z } from "zod";
import { chatText } from "./openrouter";
import { toQuoteRange, type QuoteRange, type Verse } from "./quote";
import { MAX_QUERY_CHARS } from "./tokenizer";

export interface PassageInput {
  id: string;
  // 本文(節をつないだもの)。長いときは、冒頭だけを LLM に渡す
  text: string;
  // 節ごとの本文(あれば)。節の番号を AI に見せて、引用する範囲を、節の番号で選ばせる
  verses?: readonly Verse[];
}

const SYSTEM_PROMPT = `あなたは、悩みを抱えた人の話を聞いて、日本語口語訳聖書の箇所を、そっと紹介する案内役です。
ユーザーの悩みと、すでに選ばれた3つの聖書の箇所(id と本文)が与えられます。
それぞれの箇所に、悩みに絡めた解説を書き、最後に全体をまとめた結論を書いてください。

3つの箇所は、検索で選ばれた順(読む順ではない)に渡されます。箇所には、内容に応じて、次の役割があります。
受け止める: 悩みの気持ちや状況に、寄り添う箇所(嘆き・告白・祈りなど)。「その気持ちは、昔の人も、こう言葉にしていた」と受け止める
慰める: 安らぎ・いたわりを伝える箇所
励ます: 次の一歩や、これからの見通しにつなげる箇所
- 役割は、**箇所の内容**で決める(渡された順ではない)。解説は、その箇所の内容に合う役割で書く。箇所の内容に合わない役割を、無理に当てはめない(「箇所にない意味を足さない」が優先)
- 箇所の方向が、相談者の悩みと**逆に働く**とき(例: 現実から離れていると悩む人に、「見えないものに目を注ぐ」)は、解説で、その点を、ひとこと断る(「いまのお話とは、向きが違う言葉ですが」など)。悩みを強めるように読めてしまう解釈は、書かない
- order に、読む順で、3つの id を並べる。「受け止める → 慰める → 励ます」の流れにして、嘆きや警告で終わらせない。最後は、静まる・休む・次の一歩につながる箇所にする(「空である」「苦しい」で終わる箇所は、最後にしない)。流れにならない箇所は、内容の近い順にする

書き方の規則:
- **電話番号・相談窓口の名前・受付時間は、書かない**(画面に、人が確認した、固定の案内がある。AI が書くと、間違い・古い情報になりうる)。「信頼できる人や、専門の相談窓口に、話してみる」とだけ書く。119・110 も、書かない
- 書名は、箇所の見出しに出る名前のとおりに書く(「伝道の書」を「伝道者の書」と言い換えない。画面で、名前が揺れないように)。
- 解説は、1つの箇所につき、2〜4文。聖句の本文は、別に表示されるので、書き写さない
- 聖書に書かれていないことを、書かれているように書かない。箇所の内容を、誤って説明しない。自信がなければ、控えめに書く
  解説の各文は、その箇所の、実際に書かれている内容に基づく。箇所にない意味(「過去の自分を責めすぎない」など)を、足さない。「昔の人も同じように抱えていた」のような、根拠のない決まり文句は、使わない
- 相談文から分からないことは、「お話からは分かりませんが」と書く。「書かれていないので分かりません」とは書かない(聖書に書かれていない、と読めてしまうため)
- 相談者の見立て(「このままでは破綻する」「自分がやらないとだめになる」など)を、**事実として肯定しない**。「そう感じておられるのですね」と、受け止める(正しいとも、間違っているとも、言わない)
- **相談者が書いていないことを、決めつけない**。相談者の気持ちを、いちばん都合のよい方に読み替えない(「思いやれるようになった」「成長した」「優しさの表れ」などと、根拠なく褒めない)。相談者の言葉(時制も)を、勝手に変えない。気持ちが読み取れないときは、「〜かもしれません」と、どちらの可能性も残す。人格や変化を、評価しない
- 結論の「小さな一歩」は、相談の内容と、箇所の内容から、直接つながるものにする。相談にない人物や出来事(「お世話になった人」など)を、持ち出さない
- 信仰を前提にしない。「神を信じなさい」「祈りなさい」と勧めない。「聖書では、こう語られています」「古い時代の人は、こう受け止めました」という距離で書き、信仰がなくても受け取れる、人としての言葉に言い換える
- 「〜しなさい」「〜してはならない」を、押しつけない。聖書に命令の言葉があるときは、「そういう知恵が、昔から語られてきた」と説明する
- 必ず報われる、必ず力を得る、のような、人によって違うことを、断定しない
- 病気は、神の怒りや罰ではない(現代の考え方)。病気を神の怒りや罰と読める箇所は、「古い時代には、そう考えられていた」と断り、いまの相談に当てはめない。**ただし、相談が、病気・不幸・苦しみの話でないとき(仕事・人間関係・お金など)は、この断りを書かない**(関係のない断りは、読む人を混乱させる)
- 不当な扱い・ハラスメント・暴力を、耐えるよう勧めない。耐えろ、仕えろ、と読める箇所は、「当時の状況での言葉で、いまの職場や家庭に、そのまま当てはめるものではない」と断る。結論で、信頼できる人や、専門の相談窓口に話すことも勧める
- 「ゆるしなさい」を、強要しない。ゆるせない気持ちは自然なこと。ゆるすことは、関係を続けること、被害をなかったことにすることではない
- 懺悔や罪悪感の相談で、「赦された」と断言しない。現実の相手への謝罪や償いは、別のこととして、結論で、一言添える
- 結論は、3〜5文。全体を、1つの流れでまとめ、最後に、すぐできる小さな一歩を、1つだけ、具体的に書く
- 聖書にない現代の話題(SNS、AI、ビットコイン、ハラスメントなど)のときは、preface に、「それは聖書には載っていませんが、」で始まる、1文を書く。その悩みを、聖書にもある主題(比べること、富への執着、しいたげ、など)に置き換えて、受け止める。聖書にある話題のときは、preface は null にする
- 命に関わる内容(死にたい、消えたい、自傷など)が読み取れたら、crisis を true にする。そうでなければ false
- 箇所に、節の番号((1) (2) …)が付いているときは、画面に出す範囲を、節の番号で選ぶ。
  quote_from と quote_to: **読む人に、意味が通じる、ひとまとまり**の範囲(誰が誰に何を語っているか、話の流れが分かる長さ)。短すぎて意味が通じないのも、長すぎて読む気がなくなるのも、避ける。目安は、300〜450字(2〜8節くらい)。1節だけでは意味が通じないとき(2節で1つの教え、前置きが要るとき)は、前後の節も含める。段落が短いときは、全部でよい。
  core_from と core_to: その中で、解説の根拠にした、いちばん核心の節(太字にする)。1〜3節。quote の範囲の中に収める。
  引用する範囲には、相談者を責めるように、罰するように読める節(例: 「罪びとには仕事を与えて…」)を、含めない。外すと意味が通じなくなるときは、解説で、その節が語っている当時の文脈を、ひとこと断る
  番号は、箇所に書かれたとおりにする

出力は、次の形の JSON だけ。前後に説明や、コードブロックの記号を付けない。
{"crisis": false, "preface": null, "order": ["読む順の id", ...(3つ)], "commentaries": [{"id": "箇所の id", "commentary": "解説", "quote_from": 2, "quote_to": 6, "core_from": 3, "core_to": 5}, ...(3つ)], "conclusion": "結論"}
id は、与えられたとおりに、一字も変えずに書く。`;

// 入力に、命の危険を示す語(「しにたい」など)があって、利用者が「それでも続ける」を選んだとき、システムの指示に足す
const CRISIS_ADDENDUM = `

【重要: この相談者は、死にたい気持ちを書いている可能性があります】
- 「死にたい」という気持ちを、肯定も否定もせず、そのまま受け止める。叱らず、説得せず、励まそうと急がない
- 聖書の箇所を、死や、命を軽く扱う方向に読ませない。死を望む言葉が、箇所にあれば、それを、勧めや肯定として読ませず、「そうした苦しみが、そのまま書き残されている」と受け止めるだけにする(渡された箇所に、死を望む言葉があれば、特に慎重に)
- 引用する範囲(quote_from〜quote_to)には、**死・滅び・消える・殺す・墓など、命が失われることを語る節を、含めない**(読む人に、刺さるため)。のろいの言葉(「滅ぼされますように」など)も、含めない
- 解説は、いつもより短く、やさしく。「必ず楽になる」のような、断定はしない
- 結論では、**ひとりで抱えず、信頼できる人や、専門の相談窓口に、すぐに話してほしい**ことを、はっきり書く(窓口の名前・電話番号・時間は、書かない。画面に、固定の案内がある)
- 小さな一歩は、「今日、誰か1人に、短くても、いまの気持ちを伝える」ことにする`;

// 入力に、他人を傷つけたい気持ち(「ぶっ殺してやる」など)があるとき、システムの指示に足す。画面は止めない
const HARM_ADDENDUM = `

【重要: この相談者は、他人への強い怒りや、傷つけたい気持ちを書いています】
- まず、怒りの強さを、そのまま受け止める。怒りそのものを責めない。ただし、相手を傷つける行動を、肯定も、後押しも、しない
- 「復讐は神のすること」「神が報復する」のような箇所は、**神が代わりに、相手を罰してくれる、という読みにしない**(相手への害を、正当化することになる)。「仕返しを、自分の手に握りしめない」「手を止める」という、相談者の側の知恵として、読む
- 具体的な危害の方法・計画・相手の特定には、触れない
- 結論では、「いまは、相手から離れて、その場を離れる」ことと、「本当に、相手を傷つけてしまいそうなときは、すぐに、警察などの緊急の窓口に連絡する」ことを、はっきり書く(窓口の名前・電話番号は、書かない)
- 小さな一歩は、「その場を離れて、ゆっくり息を吐く」「水を飲む」「少し時間を置く」など、怒りを鎮めるものにする`;

// LLM の返答の形。外から来るデータなので、zod で検証する。
// (Google のモデルは、JSON スキーマの minLength・maxLength・minItems などを 400 で拒否するので、
//  スキーマは API に送らず、返ってきた JSON を、ここで検証する)
const outputSchema = z.object({
  crisis: z.boolean().nullish(),
  preface: z.string().nullish(),
  // 読む順の id。使えるのは、入力の id の並べ替えになっているときだけ
  // (型が違う値で、応答全体を捨てないよう、ここでは検証せず、parseCounsel の中で調べる)
  order: z.unknown().optional(),
  commentaries: z.array(
    z.object({
      id: z.string(),
      commentary: z.string(),
      // 型が違う値(文字列など)で、応答全体を捨てないよう、ここでは検証せず、toQuoteRange で調べる
      quote_from: z.unknown().optional(),
      quote_to: z.unknown().optional(),
      core_from: z.unknown().optional(),
      core_to: z.unknown().optional(),
    }),
  ),
  conclusion: z.string(),
});

export interface Counsel {
  // 聖書にない現代の話題のときの、最初の一言(なければ null)
  preface: string | null;
  // 入力の箇所の順に、解説をつけたもの
  // quote: AI が選んだ、引用する節の範囲(節の番号。使える範囲のときだけ。なければ undefined)
  // core: その中の、核心の節(画面で太字にする。quote の範囲に収まるときだけ)
  commentaries: { id: string; commentary: string; quote?: QuoteRange; core?: QuoteRange }[];
  conclusion: string;
  // LLM が、命に関わる内容だと判断したか。**補助の防御**(非決定的)。主な検出は、AI の前の、キーワードで行う
  crisis: boolean;
  // 費用の見積もり用(本文は含まない)
  usage: { promptTokens: number | undefined; completionTokens: number | undefined };
}

// 解説を作れなかった(返答の形が違う・箇所が足りない、など)。メッセージに、入力や返答の中身を入れない
export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationError";
  }
}

// 本文を、長すぎる場合は冒頭の maxChars 字に切る
function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

// LLM に渡す、悩みと、3つの箇所
export function buildUserMessage(
  consultation: string,
  passages: readonly PassageInput[],
  maxChars: number,
): string {
  const list = passages
    .map((p, i) => {
      // 節ごとの本文があれば、節の番号を付けて見せる(引用する範囲を、番号で選ばせるため)
      const body = p.verses?.length
        ? p.verses.map((v) => `(${v.verse}) ${v.text}`).join("\n")
        : p.text;
      return `[${i + 1}] id: ${p.id}\n${truncate(body, maxChars)}`;
    })
    .join("\n\n");
  return `【悩み】\n${consultation}\n\n【聖書の箇所(検索で選ばれた順。読む順は、order で決める)】\n${list}`;
}

// AI の文章から、電話番号を取り除く(窓口の番号は、人が公式の情報で確認して、固定の案内に入れる。AI が書くと、間違い・古い情報になりうる)。
// 括弧の中に番号があれば、括弧ごと(例: 「よりそいホットライン(0120-279-338、24時間・無料)」→「よりそいホットライン」)。
// 拾う形: ①区切りのある番号(0120-279-338)②区切りのない 10〜11 桁(0120279338)③短縮の番号(#9110・#7119)④全角(NFKC でそろえてから判定)
const PHONE_DASHED = String.raw`(?:\+?81[-\s]?|0)\d{1,4}[-ー‐−\s]\d{1,4}[-ー‐−\s]\d{3,4}`;
const PHONE_PLAIN = String.raw`(?<![\d])0\d{9,10}(?![\d])`;
const PHONE_SHORT = String.raw`#\d{4}`;
const PHONE_ANY = `(?:${PHONE_DASHED}|${PHONE_PLAIN}|${PHONE_SHORT})`;
export function removePhoneNumbers(text: string): string {
  // 全角の数字・ハイフンなどは、半角にそろえて判定する。番号がなければ、元の文章を、そのまま返す(全角の記号を、勝手に変えない)
  const normalized = text.normalize("NFKC");
  if (!new RegExp(PHONE_ANY).test(normalized)) return text;
  return normalized
    .replace(new RegExp(String.raw`[（(][^（()）]*?${PHONE_ANY}[^（()）]*?[）)]`, "g"), "")
    .replace(new RegExp(PHONE_ANY, "g"), "");
}

// 返答から、最初の { から最後の } までを、JSON として取り出す(前後に説明やコードブロックが付いていても読む)
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new GenerationError("返答に JSON がありません");
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed;
  } catch {
    throw new GenerationError("返答を JSON として読めません");
  }
}

// 返答を検証して、読む順(order。なければ、入力の順)に整える。入力にない id は捨てる。
// 入力の箇所すべてに、空でない解説がなければ、止まる(画面に、解説のない引用を出さない)
export function parseCounsel(
  text: string,
  passageIds: readonly string[],
  versesById: ReadonlyMap<string, readonly Verse[]> = new Map(),
): Omit<Counsel, "usage"> {
  const parsed = outputSchema.safeParse(extractJson(text));
  if (!parsed.success) throw new GenerationError("返答の形が想定と違います");

  const byId = new Map<string, { commentary: string; quote?: QuoteRange; core?: QuoteRange }>();
  for (const item of parsed.data.commentaries) {
    const commentary = item.commentary.trim();
    // 入力にない id は捨てる。同じ id が複数あれば、最初のもの
    if (passageIds.includes(item.id) && commentary !== "" && !byId.has(item.id)) {
      // 引用の範囲は、段落の節の範囲に収まる整数の組のときだけ使う(使えなければ、呼び出し側が、先頭から短く切る)
      const verses = versesById.get(item.id) ?? [];
      const quote = toQuoteRange(item.quote_from, item.quote_to, verses);
      // 核心の節は、引用する範囲の中に収まるときだけ使う(quote がなければ、段落の中に収まれば使う)
      const rawCore = toQuoteRange(item.core_from, item.core_to, verses);
      const core =
        rawCore && (!quote || (rawCore.from >= quote.from && rawCore.to <= quote.to))
          ? rawCore
          : undefined;
      byId.set(item.id, {
        commentary: removePhoneNumbers(commentary),
        ...(quote ? { quote } : {}),
        ...(core ? { core } : {}),
      });
    }
  }
  // order が、入力の id の並べ替え(同じ id の集まり)になっているときだけ、その順にする。違えば、入力の順のまま
  const rawOrder = parsed.data.order;
  const requested: string[] =
    Array.isArray(rawOrder) && rawOrder.every((id): id is string => typeof id === "string")
      ? rawOrder
      : [];
  const isPermutation =
    requested.length === passageIds.length &&
    new Set(requested).size === requested.length &&
    requested.every((id) => passageIds.includes(id));
  const readingOrder = isPermutation ? requested : passageIds;
  const commentaries = readingOrder.map((id) => ({ id, found: byId.get(id) }));
  if (commentaries.some((c) => c.found === undefined)) {
    throw new GenerationError("すべての箇所に、解説がありません");
  }

  const conclusion = removePhoneNumbers(parsed.data.conclusion.trim());
  if (conclusion === "") throw new GenerationError("結論が空です");

  const preface = parsed.data.preface ? removePhoneNumbers(parsed.data.preface.trim()) : undefined;
  return {
    preface: preface ? preface : null,
    commentaries: commentaries.map((c) => ({
      id: c.id,
      commentary: c.found?.commentary ?? "",
      ...(c.found?.quote ? { quote: c.found.quote } : {}),
      ...(c.found?.core ? { core: c.found.core } : {}),
    })),
    conclusion,
    crisis: parsed.data.crisis === true,
  };
}

export interface GenerateOptions {
  // 入力に、命の危険を示す語があり、「それでも続ける」を選んだとき true(専用の指示を足す)
  crisisContext?: boolean;
  // 入力に、他人を傷つけたい気持ちを示す語があるとき true(専用の指示を足す。画面は止めない)
  harmContext?: boolean;
  // 1つの箇所の本文の長さの上限(既定 900字)。長い段落(詩篇など)で、入力が増えすぎるのを防ぐ
  maxCharsPerPassage?: number;
  // 相談1件ぶんの全体の締め切り(OpenRouter の呼び出しと、やり直しの待ちを止める)
  signal?: AbortSignal;
}

// 悩みと、選んだ箇所(役割の順)から、箇所ごとの解説と、結論を作る
export async function generateCounsel(
  consultation: string,
  passages: readonly PassageInput[],
  options: GenerateOptions = {},
): Promise<Counsel> {
  if (consultation.trim() === "") throw new RangeError("相談文が空です");
  if (consultation.length > MAX_QUERY_CHARS) {
    throw new RangeError(`入力が長すぎます(${MAX_QUERY_CHARS}字まで)`);
  }
  if (passages.length === 0) throw new RangeError("箇所がありません");

  const { text, usage } = await chatText(
    {
      system:
        SYSTEM_PROMPT +
        (options.crisisContext ? CRISIS_ADDENDUM : "") +
        (options.harmContext ? HARM_ADDENDUM : ""),
      user: buildUserMessage(consultation, passages, options.maxCharsPerPassage ?? 900),
      // 推論のトークンも、この中に数えられる。解説3つ + 結論で、出力が長いので、余裕を持たせる
      maxTokens: 6000,
      temperature: 0.6,
      reasoningEffort: "low",
      // 解説と結論を書く仕事。OPENROUTER_WRITING_MODEL があれば、そのモデルで書く
      purpose: "writing",
    },
    options.signal ? { signal: options.signal } : {},
  );
  return {
    ...parseCounsel(
      text,
      passages.map((p) => p.id),
      new Map(passages.flatMap((p) => (p.verses ? [[p.id, p.verses] as const] : []))),
    ),
    usage,
  };
}
