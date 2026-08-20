import { describe, expect, it } from "vitest";
import { RuleBasedQueryFactFrameExtractor } from
  "../../../../shared/query-fact-frame-extraction-rules.js";
import { captureRecallQueryFactFrames } from
  "../../../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";
import { deriveQueryFactFrameOsfObligation } from
  "../../../../recall/field/open-semantic-factors/query-obligation.js";

const extractor = new RuleBasedQueryFactFrameExtractor();

describe("query fact-frame OSF obligation", () => {
  it("certifies the narrow G6 binary layout from the rule-based parse trace", async () => {
    const obligation = await derive("What degree did I graduate with?");
    expect(obligation).toMatchObject({
      operator_id: "query_fact_frame_osf_obligation_v2",
      predicate: { surface: "graduate", source_span: [18, 26] },
      subject: { surface: "I", source_span: [16, 17], position: 0 },
      value: { surface: "What degree", source_span: [0, 11], position: 1 },
      constraints: [],
      arity: 2
    });
  });

  it("certifies a copular duration layout without overlapping its nodes", async () => {
    const obligation = await derive("How long is my daily commute to work?");
    expect(obligation).toMatchObject({
      operator_id: "query_fact_frame_osf_obligation_v2",
      predicate: { surface: "is", source_span: [9, 11] },
      subject: { surface: "my daily commute to work", source_span: [12, 36], position: 0 },
      value: { surface: "How long", source_span: [0, 8], position: 1 },
      constraints: [],
      arity: 2
    });
  });

  it("certifies ordered grounded tail constraints before a location result", async () => {
    const obligation = await derive("Where did I redeem a $5 coupon on coffee creamer?");
    expect(obligation).toMatchObject({
      operator_id: "query_fact_frame_osf_obligation_v2",
      predicate: { surface: "redeem", source_span: [12, 18] },
      subject: { surface: "I", source_span: [10, 11], position: 0 },
      constraints: [
        { surface: "a $5 coupon on coffee creamer", source_span: [19, 48], position: 1 }
      ],
      value: { surface: "Where", source_span: [0, 5], position: 2 },
      arity: 3
    });
  });

  it.each([
    "What did Alice buy at the market?",
    "What did Alice give Bob?",
    "What and where did Alice travel?",
    "What degree did What degree graduate with?"
  ])("leaves unsupported or explicit-extra layouts unavailable: %s", async (query) => {
    await expect(derive(query)).resolves.toBeNull();
  });
});

async function derive(query: string) {
  const capture = await captureRecallQueryFactFrames({
    query_text: query,
    port: extractor
  });
  return deriveQueryFactFrameOsfObligation({ query_text: query, fact_frame_capture: capture });
}
