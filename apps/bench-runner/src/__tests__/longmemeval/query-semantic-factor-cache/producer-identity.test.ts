import { describe, expect, it } from "vitest";
import { RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID } from
  "@do-soul/alaya-protocol";
import { RuleBasedQueryFactFrameExtractor } from "@do-soul/alaya-core";
import { OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE } from
  "@do-soul/alaya-soul";

describe("query semantic factor producer identity", () => {
  it("binds the Core parser and Soul request template to the Protocol authority", () => {
    expect(new RuleBasedQueryFactFrameExtractor().operator_id)
      .toBe(RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID);
    expect(OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE).toContain(
      `"fact_frame_producer_operator_id":"${RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID}"`
    );
  });
});
