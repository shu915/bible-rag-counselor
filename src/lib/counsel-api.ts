// 相談1件ぶんの処理(危機の検出 → 書き換え・検索・選択 → 解説と結論)と、画面に渡す形。
// API ルート(src/app/api/counsel/route.ts)から呼ぶ。ルートは、入力の検証と、エラーの変換だけにする。
// ユーザーの入力は繊細なので、入力も結果も、ログにも例外にも出さない。
import type { CounselRequest, CounselResponse, PassageView } from "./counsel-schema";
import { LIFE_LOSS_WORDS, detectCrisis, detectHarmToOthers } from "./crisis";
import { HARM_CONTEXT_EXCLUDED_PASSAGE_IDS } from "./excluded-passages";
import { generateCounsel } from "./generate-counsel";
import { buildQuote } from "./quote";
import { searchPassages, type Queryable } from "./search-passages";

export { MAX_INPUT_CHARS, counselRequestSchema } from "./counsel-schema";

// 画面に出す、AI の文章の長さの上限(字)。プロンプトの規則(解説は2〜4文、結論は3〜5文)の、数倍の余裕。
// 相談文に「長く書け」と書かれて、AI が従っても、画面が、際限なく長くならないための、表示側の上限
const MAX_COMMENTARY_CHARS = 1_200;
const MAX_CONCLUSION_CHARS = 1_500;
const MAX_PREFACE_CHARS = 400;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// 命の危険を示す入力か(「それでも続ける」を選んでいなければ)。AI を呼ばない固定の画面にする入力。
// API の入口で、回数制限の**前**に判定する(数えず、上限でも止めない。限度に達した人にも、案内が届くように)
export function isCrisisInput(request: CounselRequest): boolean {
  return !request.continueAnyway && detectCrisis(request.consultation);
}

export async function runCounsel(
  db: Queryable,
  request: CounselRequest,
  signal?: AbortSignal,
): Promise<CounselResponse> {
  const { consultation } = request;
  const options = signal ? { signal } : {};

  // 1. 命の危険を示す語は、AI を呼ぶ前に、キーワードで止める
  const keywordHit = detectCrisis(consultation);
  if (keywordHit && !request.continueAnyway) return { kind: "crisis" };

  // 2. 書き換え → 検索 → 選択
  // 他人を傷つけたい気持ちを示す語があるときは、相談者を責めるように読める箇所(「人殺し」「地獄の火」など)を、候補から外す
  const harm = detectHarmToOthers(consultation);
  const found = await searchPassages(
    db,
    consultation,
    harm ? { ...options, excludeIds: HARM_CONTEXT_EXCLUDED_PASSAGE_IDS } : options,
  );
  // 3. 解説と結論
  // 命の危険を示す語があって、「それでも続ける」を選んだときは、専用の指示を足す(死を望む箇所を、勧めに読ませない など)
  const counsel = await generateCounsel(
    consultation,
    found.passages.map((p) => ({ id: p.id, text: p.text, verses: p.verses })),
    // 他人を傷つけたい気持ちを示す語があるときは、画面は止めずに、専用の指示を足す(神が代わりに罰する、と読ませない など)
    { ...options, crisisContext: keywordHit, harmContext: harm },
  );

  // 補助の防御: AI が、命に関わる内容だと判断したら、解説を出さずに、固定の画面にする
  if (counsel.crisis && !request.continueAnyway) return { kind: "crisis" };

  // 読む順(AI が決めた order。なければ、検索の順)に、画面の箇所を並べる
  const byId = new Map(found.passages.map((p) => [p.id, p]));
  const inReadingOrder = counsel.commentaries.flatMap((c) => {
    const passage = byId.get(c.id);
    return passage ? [passage] : [];
  });
  const passages = inReadingOrder.map((passage): PassageView => {
    const item = counsel.commentaries.find((c) => c.id === passage.id);
    // 引用の範囲と、核心の節は、AI が節の番号で選んだもの(使えない範囲は、先頭から短く切る)。本文は、必ず DB の節
    // 命の危険を示す語があって「それでも続ける」を選んだときは、命が失われることを語る節(滅び・消える・殺す など)を、引用から外す
    const quote = buildQuote(
      passage.verses,
      item?.quote,
      item?.core,
      keywordHit ? { avoid: LIFE_LOSS_WORDS } : {},
    );
    return {
      reference: passage.reference,
      verses: passage.verses.map((v) => ({
        label: v.verse === v.verse_end ? `${v.verse}` : `${v.verse}-${v.verse_end}`,
        text: v.text,
        inQuote: v.verse_end >= quote.from && v.verse <= quote.to,
        core:
          quote.core !== undefined && v.verse_end >= quote.core.from && v.verse <= quote.core.to,
      })),
      commentary: clip(item?.commentary ?? "", MAX_COMMENTARY_CHARS),
    };
  });

  return {
    kind: "ok",
    preface: counsel.preface === null ? null : clip(counsel.preface, MAX_PREFACE_CHARS),
    passages,
    conclusion: clip(counsel.conclusion, MAX_CONCLUSION_CHARS),
    showHelp: keywordHit || counsel.crisis,
  };
}
