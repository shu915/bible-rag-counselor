// 分かち書きのトークンを、Postgres の to_tsquery に渡す文字列にする(OR でつなぐ)。
// to_tsquery には、& | ! : ( ) ' \ などの演算子や記号があり、そのまま渡すと、構文エラーや意図しない検索になる。
// 文書側(tsvector)は simple 設定なので、検索側も simple 設定で使う。
//
// 安全のため、トークンは「文字・数字・長音記号だけ」のものに絞り、全体を引用符で囲む。
// 記号が混ざったトークン(`foo':*` など)は、検索の手がかりにならないので、捨てる。
const SAFE_TOKEN = /^[\p{L}\p{N}ー]+$/u;

// 使えるトークンが1つもなければ undefined(検索しない)
export function buildTsQuery(tokens: readonly string[]): string | undefined {
  const safe = [...new Set(tokens)].filter((token) => SAFE_TOKEN.test(token));
  if (safe.length === 0) return undefined;
  return safe.map((token) => `'${token}'`).join(" | ");
}
