import { describe, expect, it } from "vitest";
import { OfficialApiGardenProvider, type GardenCompileContext } from "../../garden/compute-provider.js";

const CONTEXT: GardenCompileContext = {
  workspace_id: "workspace-source-grounding",
  run_id: "run-source-grounding",
  surface_id: null,
  turn_messages: []
};

describe("official Garden source grounding", () => {
  it("marks a signal whose claimed evidence span is absent as rejected", async () => {
    const provider = providerFor({
      matched_text: "Alice moved to Berlin.",
      distilled_fact: "Alice moved to Berlin."
    });

    const [signal] = await provider.compile("I moved to Berlin.", CONTEXT);
    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["matched_text_absent"]
    });
  });

  it("uses the verified source span when distilled semantics are not verbatim", async () => {
    const provider = providerFor({
      matched_text: "I moved to Berlin.",
      distilled_fact: "Alice lives in Berlin.",
      canonical_entities: ["alice", "berlin", "operator"]
    });

    const [signal] = await provider.compile("I moved to Berlin.", CONTEXT);

    expect(signal?.raw_payload.distilled_fact).toBe("I moved to Berlin.");
    expect(signal?.canonical_entities).toEqual(["berlin", "operator"]);
  });

  it("retains a verbatim atomic fact and source-backed entities", async () => {
    const provider = providerFor({
      matched_text: "Alice moved to Berlin.",
      distilled_fact: "Alice moved to Berlin.",
      canonical_entities: ["alice", "berlin", "bob"]
    });

    const [signal] = await provider.compile("Alice moved to Berlin.", CONTEXT);

    expect(signal?.raw_payload.distilled_fact).toBe("Alice moved to Berlin.");
    expect(signal?.canonical_entities).toEqual(["alice", "berlin"]);
  });

  it("expands a fragment to its complete source assertion including negation", async () => {
    const provider = providerFor({
      matched_text: "moved to Berlin",
      distilled_fact: "Alice lives in Berlin."
    });

    const [signal] = await provider.compile("I never moved to Berlin.", CONTEXT);

    expect(signal?.raw_payload.distilled_fact).toBe("I never moved to Berlin.");
    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "grounded",
      reasons: expect.arrayContaining([
        "matched_text_expanded_to_source_assertion",
        "proposed_distilled_fact_not_verbatim"
      ])
    });
  });

  it.each([
    ["I moved to Berlin.I started a job.", "moved to Berlin", "I moved to Berlin."],
    ["我搬到柏林。我开始工作。", "搬到柏林", "我搬到柏林。"],
    ["I moved to Berlin; I started a job.", "moved to Berlin", "I moved to Berlin"],
    ["I moved to Berlin; I started a job.", "started a job", "I started a job."],
    ["I moved to Berlin and I started a job.", "started a job", "I started a job."]
  ])("isolates a complete assertion around %s", async (source, matchedText, assertion) => {
    const provider = providerFor({ matched_text: matchedText, distilled_fact: matchedText });
    const [signal] = await provider.compile(source, CONTEXT);
    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "grounded" });
    expect(signal?.raw_payload.distilled_fact).toBe(assertion);
  });

  it.each([
    ["I moved to Berlin and started a job.", "started a job"],
    ["I met Dr. Smith yesterday.", "Smith"],
    ["I met Dr. smith yesterday.", "smith"]
  ])("fails closed when the clause around %s is not provably complete", async (source, matchedText) => {
    const provider = providerFor({ matched_text: matchedText, distilled_fact: matchedText });
    const [signal] = await provider.compile(source, CONTEXT);
    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["source_assertion_incomplete"]
    });
  });

  it.each([
    ["I moved to Berlin, e.g. for work.", "for work"],
    ["I moved to Berlin, i.e. the capital.", "the capital"],
    ["I met prof. smith yesterday.", "smith"],
    ["I arrived at approx. noon.", "noon"],
    ["I moved to the U.S. for work.", "for work"],
    ["I used version v1.2. then deployed.", "then deployed"]
  ])("fails closed at a structurally ambiguous dot boundary in %s", async (source, matchedText) => {
    const provider = providerFor({ matched_text: matchedText, distilled_fact: matchedText });
    const [signal] = await provider.compile(source, CONTEXT);
    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["source_assertion_incomplete"]
    });
  });

  it("keeps ordinary unambiguous sentence boundaries", async () => {
    const provider = providerFor({
      matched_text: "Bob stayed in Paris.",
      distilled_fact: "Bob stayed in Paris."
    });
    const [signal] = await provider.compile("Alice moved to Berlin. Bob stayed in Paris.", CONTEXT);
    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "grounded" });
    expect(signal?.raw_payload.distilled_fact).toBe("Bob stayed in Paris.");
  });

  it("does not confuse a self-contained former-role adjective with discourse anaphora", async () => {
    const source = "My former employer was Acme.";
    const provider = providerFor({ matched_text: source, distilled_fact: source });
    const [signal] = await provider.compile(source, CONTEXT);
    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "grounded" });
    expect(signal?.raw_payload.distilled_fact).toBe(source);
  });

  it("does not substitute a different fact from the same turn", async () => {
    const provider = providerFor({
      matched_text: "Alice moved to Berlin.",
      distilled_fact: "Bob lives in Paris.",
      canonical_entities: ["alice", "bob", "paris"]
    });

    const [signal] = await provider.compile(
      "Alice moved to Berlin. Bob lives in Paris.",
      CONTEXT
    );

    expect(signal?.raw_payload.distilled_fact).toBe("Alice moved to Berlin.");
    expect(signal?.canonical_entities).toEqual(["alice"]);
  });

  it.each([
    ["I bought apples, and oranges, and bananas.", "oranges"],
    ["I moved to Berlin, and started a new job.", "started a new job"]
  ])("rejects a non-assertion coordinate fragment from %s", async (source, matchedText) => {
    const provider = providerFor({ matched_text: matchedText, distilled_fact: matchedText });
    const [signal] = await provider.compile(source, CONTEXT);
    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["source_assertion_incomplete"]
    });
  });

  it("defers an anaphoric assertion instead of persisting context-dependent content", async () => {
    const provider = providerFor({
      matched_text: "She moved there in March 2024.",
      distilled_fact: "Alice moved to Berlin in March 2024.",
      canonical_entities: ["alice", "berlin"]
    });
    const [signal] = await provider.compile(
      "Alice discussed Berlin. She moved there in March 2024.",
      CONTEXT
    );
    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["source_assertion_not_self_contained"]
    });
  });

  it.each([
    ["Alice chose Berlin over Paris. The former is cheaper.", "The former is cheaper."],
    ["Alice compared Berlin with Paris. The latter is warmer.", "The latter is warmer."],
    ["Alice selected the primary option. The same applies tomorrow.", "The same applies tomorrow."],
    ["Alice documented a rule. The above is binding.", "The above is binding."],
    ["Alice documented a rule. The below is optional.", "The below is optional."],
    ["Alice documented a rule. The aforementioned rule is binding.", "The aforementioned rule is binding."],
    ["Alice selected an option. Such a choice is risky.", "Such a choice is risky."],
    ["小明比较了两个方案。前者更便宜。", "前者更便宜。"],
    ["小明比较了两个方案。后者更稳定。", "后者更稳定。"],
    ["小明写下一个方案。上述方案需要审批。", "上述方案需要审批。"],
    ["小明写下一个方案。该方案需要审批。", "该方案需要审批。"],
    ["小明写下一个方案。此项需要审批。", "此项需要审批。"],
    ["小明写下一个方案。同上。", "同上。"]
  ])("rejects a discourse-dependent assertion: %s", async (source, matchedText) => {
    const provider = providerFor({ matched_text: matchedText, distilled_fact: matchedText });
    const [signal] = await provider.compile(source, CONTEXT);
    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["source_assertion_not_self_contained"]
    });
  });

  it("rejects an over-budget source assertion rather than truncating durable truth", async () => {
    const source = `I ${"really ".repeat(90)}moved.`;
    const provider = providerFor({ matched_text: "moved", distilled_fact: source });
    const [signal] = await provider.compile(source, CONTEXT);
    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["source_assertion_too_long"]
    });
  });

  it.each(["We deploy weekly.", "我们每周部署。", "我司位于上海。"]) (
    "does not map a plural or organization subject to operator: %s",
    async (source) => {
      const provider = providerFor({
        matched_text: source,
        distilled_fact: source,
        canonical_entities: ["operator"]
      });
      const [signal] = await provider.compile(source, CONTEXT);
      expect(signal?.canonical_entities).toBeUndefined();
    }
  );

  it("deduplicates first-person and operator aliases", async () => {
    const provider = providerFor({
      matched_text: "I moved to Berlin.",
      distilled_fact: "I moved to Berlin.",
      canonical_entities: ["i", "operator", "berlin"]
    });
    const [signal] = await provider.compile("I moved to Berlin.", CONTEXT);
    expect(signal?.canonical_entities).toEqual(["operator", "berlin"]);
  });

  it.each([
    ["I moved to Berlin.", ["i", "berlin"]],
    ["Please send the report to me.", ["me"]],
    ["My preference is dark mode.", ["my"]],
    ["The final choice is mine.", ["mine"]],
    ["I completed the review myself.", ["myself"]],
    ["我搬到北京。", ["我"]]
  ])("normalizes singular first-person entities to operator: %s", async (source, entities) => {
    const provider = providerFor({
      matched_text: source,
      distilled_fact: source,
      canonical_entities: entities
    });
    const [signal] = await provider.compile(source, CONTEXT);
    expect(signal?.canonical_entities).toEqual(
      source.includes("Berlin") ? ["operator", "berlin"] : ["operator"]
    );
  });

  it("keeps a bounded verification window when the assertion occurs late in a long turn", async () => {
    const assertion = "I moved to Berlin.";
    const source = `${"Background context. ".repeat(180)}${assertion}`;
    const provider = providerFor({ matched_text: assertion, distilled_fact: assertion });
    const [signal] = await provider.compile(source, CONTEXT);
    expect(signal?.raw_payload.full_turn_content).toContain(assertion);
    expect(String(signal?.raw_payload.full_turn_content).length).toBeLessThanOrEqual(2_048);
  });
});

function providerFor(fields: Record<string, unknown>): OfficialApiGardenProvider {
  return new OfficialApiGardenProvider({
    apiKey: "sk-test",
    extractor: {
      extract: async () => ({
        rawJson: JSON.stringify({
          signals: [{
            signal_kind: "potential_claim",
            object_kind: "activity",
            confidence: 0.9,
            ...fields
          }]
        })
      })
    },
    generateSignalId: () => "signal-source-grounding"
  });
}
