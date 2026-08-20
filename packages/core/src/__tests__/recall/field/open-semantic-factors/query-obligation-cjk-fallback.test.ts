import { afterEach, describe, expect, it } from "vitest";
import {
  OPEN_SEMANTIC_DURATION_WH_SURFACES,
  OPEN_SEMANTIC_LOCATION_WH_SURFACES,
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID
} from "@do-soul/alaya-protocol";
import {
  RuleBasedQueryFactFrameExtractor,
  traceRuleBasedQueryFactFrame
} from "../../../../shared/query-fact-frame-extraction-rules.js";
import type { QueryFactFrameExtractionPort } from
  "../../../../shared/query-fact-frame-extraction-port.js";
import { captureRecallQueryFactFrames } from
  "../../../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";
import { deriveQueryFactFrameOsfObligation } from
  "../../../../recall/field/open-semantic-factors/query-obligation.js";
import {
  __resetCjkSegmentationStateForTests,
  __setCjkSegmentationLoaderForTests,
  warmCjkSegmentation
} from "../../../../shared/cjk-segmentation.js";
import {
  CJK_INTERROGATIVE_FALLBACK_ATOMS,
  CJK_INTERROGATIVE_RESULT_FORMS
} from "../../../../shared/fact-frame-grammar/cjk-interrogative-forms.js";

const official = new RuleBasedQueryFactFrameExtractor();
const syncPort: QueryFactFrameExtractionPort = {
  operator_id: RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
  async extract(query: string) {
    const trace = traceRuleBasedQueryFactFrame(query);
    return trace === null ? Object.freeze([]) : Object.freeze([trace.frame]);
  }
};

describe("CJK obligation jieba fallback", () => {
  it("keeps warm interrogative forms and cold fallback atoms on one list", () => {
    const fallbackWh = CJK_INTERROGATIVE_FALLBACK_ATOMS.filter((atom) =>
      (CJK_INTERROGATIVE_RESULT_FORMS as readonly string[]).includes(atom));
    expect(new Set(fallbackWh)).toEqual(new Set(CJK_INTERROGATIVE_RESULT_FORMS));
    expect(new Set(CJK_INTERROGATIVE_RESULT_FORMS)).toEqual(new Set([
      ...OPEN_SEMANTIC_DURATION_WH_SURFACES.filter((surface) => /\p{Script=Han}/u.test(surface)),
      ...OPEN_SEMANTIC_LOCATION_WH_SURFACES.filter((surface) => /\p{Script=Han}/u.test(surface))
    ]));
  });

  afterEach(() => {
    __resetCjkSegmentationStateForTests();
  });

  it("certifies basic interrogatives when the segmenter is unavailable", async () => {
    __setCjkSegmentationLoaderForTests(async () => null);
    await expect(warmCjkSegmentation()).resolves.toBe(false);
    await expect(derive(official, "每天上班通勤要多久？")).resolves.toMatchObject({
      predicate: { surface: "要" },
      subject: { surface: "每天上班通勤" },
      value: { surface: "多久" },
      arity: 2
    });
    await expect(derive(official, "每天上班通勤要多长时间？")).resolves.toMatchObject({
      value: { surface: "多长时间" },
      arity: 2
    });
    await expect(derive(official, "优惠券在哪里？")).resolves.toMatchObject({
      predicate: { surface: "在" },
      subject: { surface: "优惠券" },
      value: { surface: "哪里" },
      arity: 2
    });
    await expect(derive(official, "优惠券在何处？")).resolves.toMatchObject({
      value: { surface: "何处" }
    });
    await expect(derive(official, "优惠券在哪儿？")).resolves.toMatchObject({
      value: { surface: "哪儿" }
    });
    await expect(derive(official, "每天上班通勤要四十五分钟。")).resolves.toBeNull();
    await expect(derive(official, "孩子多大了？")).resolves.toBeNull();
    await expect(derive(official, "会议是几点？")).resolves.toBeNull();
    await expect(derive(official, "黄金是一种金属。")).resolves.toBeNull();
  });

  it("certifies basic interrogatives before jieba warms", async () => {
    __setCjkSegmentationLoaderForTests(() => new Promise(() => undefined));
    await expect(derive(syncPort, "每天上班通勤要多久？")).resolves.toMatchObject({
      value: { surface: "多久" },
      arity: 2
    });
    await expect(derive(syncPort, "优惠券在哪儿？")).resolves.toMatchObject({
      value: { surface: "哪儿" },
      arity: 2
    });
    await expect(derive(syncPort, "黄金是一种金属。")).resolves.toBeNull();
  });
});

async function derive(
  port: QueryFactFrameExtractionPort,
  query: string
) {
  const capture = await captureRecallQueryFactFrames({
    query_text: query,
    port
  });
  return deriveQueryFactFrameOsfObligation({ query_text: query, fact_frame_capture: capture });
}
