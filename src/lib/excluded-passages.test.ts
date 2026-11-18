import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EXCLUDED_PASSAGES,
  EXCLUDED_PASSAGE_IDS,
  GENERIC_PASSAGE_IDS,
  HARM_CONTEXT_EXCLUDED_PASSAGE_IDS,
} from "./excluded-passages";

describe("EXCLUDED_PASSAGES(中身)", () => {
  it("すべての段落に、理由がある。id の重複はない", () => {
    for (const passage of EXCLUDED_PASSAGES) {
      expect(passage.reason.trim()).not.toBe("");
    }
    expect(new Set(EXCLUDED_PASSAGE_IDS).size).toBe(EXCLUDED_PASSAGE_IDS.length);
  });
});

// 除外する id が、実際のデータに、実在するかの確認。
// `bible:convert` の仕様が変わって、id が変わると、除外が、黙って効かなくなるため。
// data/bible-paragraphs.json は、git に入れていない生成物(再配布が未確認)。手元にあるときだけ、実行する
// (CI など、ファイルがない場所では、スキップされる。ローカルでは、`npm run bible:fetch` → `bible:convert` で作る)
const DATA_PATH = path.join(process.cwd(), "data", "bible-paragraphs.json");

describe.runIf(fs.existsSync(DATA_PATH))("EXCLUDED_PASSAGE_IDS(実データに、実在する)", () => {
  it("除外するすべての id が、段落の id として、実在する", () => {
    const raw: unknown = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    const paragraphs = z.array(z.object({ id: z.string() })).parse(raw);
    const existing = new Set(paragraphs.map((p) => p.id));
    const missing = EXCLUDED_PASSAGE_IDS.filter((id) => !existing.has(id));
    expect(missing).toEqual([]);
    // 汎用的な段落も、実在する
    expect(GENERIC_PASSAGE_IDS.filter((id) => !existing.has(id))).toEqual([]);
    // 他人を傷つけたい入力のときだけ外す段落も、実在する
    expect(HARM_CONTEXT_EXCLUDED_PASSAGE_IDS.filter((id) => !existing.has(id))).toEqual([]);
  });
});
