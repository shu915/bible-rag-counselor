// 日本語の分かち書き(全文検索用)。
// 文を形態素解析して、名詞・動詞・形容詞の「原形」だけを、空白区切りの文字列にする。
// **文書側(DB 投入時)と検索側(ユーザー入力時)で、必ずこの関数を使う**。
// 別の方法で分かち書きすると、同じ語が一致しなくなる。
import * as kuromoji from "@patdx/kuromoji";
import NodeDictionaryLoader from "@patdx/kuromoji/node";
import * as path from "node:path";

// 辞書(約17MB、IPADIC)。Vercel にデプロイするときは、この辞書ファイルをデプロイに含める設定が要る
const DICTIONARY_PATH = path.join(process.cwd(), "node_modules", "@patdx", "kuromoji", "dict");

// ユーザー入力の長さの上限。kuromoji は、同じ文字を繰り返した長い入力で、処理時間とメモリが急に増える
// (数千字で数秒、数万字でメモリ切れ)。普通の日本語の文なら、この長さで十分速い。
// 聖書の段落は最大約 2,700 字なので、文書側(tokenize)にはこの上限をかけない
export const MAX_QUERY_CHARS = 2000;

type Tokenizer = Awaited<ReturnType<kuromoji.TokenizerBuilder["build"]>>;
type Token = ReturnType<Tokenizer["tokenize"]>[number];

// 残す品詞(IPADIC の品詞名)
const KEPT_POS = new Set(["名詞", "動詞", "形容詞"]);

// 品詞の細分類で、意味が薄いものを捨てる(全文検索のノイズになる)。
//  名詞: 代名詞(あなた・わたし・何)、非自立(こと・もの・うち)、数、接尾
//  動詞: 非自立(いる・あげる・なさる)、接尾(せる・れる)
//  形容詞: 非自立(ない など)
const DROPPED_DETAIL: Record<string, Set<string>> = {
  名詞: new Set(["代名詞", "非自立", "数", "接尾"]),
  動詞: new Set(["非自立", "接尾"]),
  形容詞: new Set(["非自立"]),
};

// 品詞の分類ではノイズを除ききれなかった、どの文にも出てきて、検索の手がかりにならない語。
// 全段落で頻度を数えて決めた(「あなたがた」の「がた」は 4,000 回超、「ない」は 2,000 回超)
const STOP_WORDS = new Set(["する", "ある", "いる", "なる", "できる", "がた", "ない"]);

// 文字か数字を1つも含まないもの(記号だけ)は、後で to_tsquery に渡すと構文を壊すので、ここで捨てる。
// 長音記号「ー」は、Unicode では文字(Lm)だが、これだけでは語にならないので、数えない
function hasContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.replaceAll("ー", ""));
}

// 連続するカタカナ(2字以上)。口語訳のカタカナは、ほぼ人名・地名(モーセ、ペテロ)。
// kuromoji は辞書にない固有名詞を割ってしまう(モーセ→モー+セ)ので、割らずに1つのトークンにする
const KATAKANA_RUN = /[ァ-ヶー]{2,}/g;

// 辞書の読み込みは重い(約0.2秒)ので、1回だけ読み込んで使い回す。失敗したら、次の呼び出しでやり直す
let tokenizerPromise: Promise<Tokenizer> | undefined;
function getTokenizer(): Promise<Tokenizer> {
  tokenizerPromise ??= new kuromoji.TokenizerBuilder({
    loader: new NodeDictionaryLoader({ dic_path: DICTIONARY_PATH }),
  })
    .build()
    .catch((error: unknown) => {
      tokenizerPromise = undefined;
      throw error;
    });
  return tokenizerPromise;
}

// 辞書にない語(未知語)は、原形が "*" になるので、表層形をそのまま使う
function toBaseForm(token: Token): string {
  return token.basic_form && token.basic_form !== "*" ? token.basic_form : token.surface_form;
}

function isKept(token: Token): boolean {
  if (!hasContent(toBaseForm(token))) return false;
  if (!KEPT_POS.has(token.pos)) return false;
  if (DROPPED_DETAIL[token.pos]?.has(token.pos_detail_1)) return false;
  return !STOP_WORDS.has(toBaseForm(token));
}

// 文を、検索用のトークン(原形)の配列にする。順序と重複は、元の文のまま残す。
// 長さの上限はない(文書側の DB 投入で使う)。ユーザー入力には tokenizeQuery を使う
export async function tokenize(text: string): Promise<string[]> {
  const tokenizer = await getTokenizer();
  // 全角英数・半角カナなどの表記の揺れをそろえる(文書側と検索側で同じ処理になる)
  const normalized = text.normalize("NFKC");

  // カタカナの連続は、そのままトークンにして、それ以外の部分だけを kuromoji に渡す
  const tokens: string[] = [];
  let last = 0;
  const analyze = (segment: string): void => {
    if (segment) tokens.push(...tokenizer.tokenize(segment).filter(isKept).map(toBaseForm));
  };
  for (const match of normalized.matchAll(KATAKANA_RUN)) {
    analyze(normalized.slice(last, match.index));
    if (hasContent(match[0])) tokens.push(match[0]);
    last = match.index + match[0].length;
  }
  analyze(normalized.slice(last));
  return tokens;
}

// ユーザー入力用。長すぎる入力は、処理を始める前に断る(サービス停止の攻撃を防ぐ)
export async function tokenizeQuery(text: string): Promise<string[]> {
  if (text.length > MAX_QUERY_CHARS) {
    throw new RangeError(`入力が長すぎます(${MAX_QUERY_CHARS}字まで)`);
  }
  return tokenize(text);
}

// DB の content_tokens に入れる、空白区切りの文字列にする(文書側)
export async function tokenizeToString(text: string): Promise<string> {
  return (await tokenize(text)).join(" ");
}
