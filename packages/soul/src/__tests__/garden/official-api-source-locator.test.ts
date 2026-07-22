import { describe, expect, it, vi } from "vitest";
import {
  OfficialApiGardenProvider,
  auditOfficialApiSignalFormation,
  parseOfficialApiSignals,
  type GardenCompileContext
} from "../../garden/compute-provider.js";
import { resolveGardenSignalGrounding } from "../../garden/grounding/signal-source-grounding.js";
import { buildOfficialApiSourceAssertions } from "../../garden/grounding/source-locator.js";
import { createSignal } from "./materialization-router-fixture.js";

const EMPTY_CONTEXT: GardenCompileContext = {
  workspace_id: "workspace-locator",
  run_id: "run-locator",
  surface_id: null,
  turn_messages: []
};

describe("official API exact sentence-range locator", () => {
  it("parses a valid locator without changing a legacy draft", () => {
    const legacy = signalJson();
    const [legacyDraft] = parseOfficialApiSignals(JSON.stringify({ signals: [legacy] }));
    const [locatedDraft] = parseOfficialApiSignals(JSON.stringify({
      signals: [{
        ...legacy,
        source_locator: {
          contract_version: 1,
          kind: "exact_sentence_range",
          start_span: 1,
          end_span: 1
        }
      }]
    }));

    expect(JSON.stringify(legacyDraft)).toBe(JSON.stringify(legacy));
    expect(locatedDraft?.source_locator).toEqual({
      contract_version: 1,
      kind: "exact_sentence_range",
      start_span: 1,
      end_span: 1
    });
  });

  it.each([
    null,
    {},
    { contract_version: 2, kind: "exact_sentence_range", start_span: 1, end_span: 1 },
    { contract_version: 1, kind: "exact_sentence_range", start_span: 0, end_span: 1 },
    { contract_version: 1, kind: "exact_sentence_range", start_span: 2, end_span: 1 },
    { contract_version: 1, kind: "exact_sentence_range", start_span: 1, end_span: 3 },
    { contract_version: 1, kind: "exact_sentence_range", start_span: 1, end_span: 1, extra: true }
  ])("drops a signal that declares malformed locator %j", (sourceLocator) => {
    expect(() => parseOfficialApiSignals(JSON.stringify({
      signals: [{ ...signalJson(), source_locator: sourceLocator }]
    }))).toThrow("signals array contained no valid entries");
  });

  it("rejects a selected User span that does not contain the proposed exact quote", async () => {
    const provider = providerFor({
      source_locator: locator(1),
      matched_text: "Alice lives on Mars.",
      distilled_fact: "Alice lives on Mars."
    });

    const source = "I moved to Berlin. I work remotely.";
    const [signal] = await provider.compile(source, contextForUser(source));

    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["matched_text_absent"]
    });
  });

  it("rejects a locator that points at Assistant context", async () => {
    const context: GardenCompileContext = {
      ...EMPTY_CONTEXT,
      turn_messages: [
        { message_id: "u1", role: "user", content: "I moved to Berlin." },
        { message_id: "a1", role: "assistant", content: "You live in Berlin." }
      ]
    };
    const provider = providerFor({ source_locator: locator(2) });
    const [signal] = await provider.compile("I moved to Berlin.", context);

    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "rejected" });
  });

  it("rejects a range wider than two User spans", async () => {
    const provider = providerFor({
      source_locator: { ...locator(1), end_span: 3 }
    });
    const source = "I moved to Berlin. I work remotely. I prefer TypeScript.";
    await expect(provider.compile(source, contextForUser(source)))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each([
    "Is Max a Golden Retriever?",
    "I found a new collar. It is worth triple what I paid.",
    "For Sophia, it was a coffee shop in the city."
  ])("does not loosen existing source assertion rejection for %s", async (source) => {
    const provider = providerFor({ source_locator: locator(source.includes("I found") ? 2 : 1) });
    const [signal] = await provider.compile(source, contextForUser(source));
    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "rejected" });
  });

  it("keeps a first-person assertion that also asks an indirect question", async () => {
    const provider = providerFor({
      source_locator: locator(1),
      matched_text: "visiting my sister Emily in Denver"
    });
    const source = "I'm thinking of visiting my sister Emily in Denver, and I was wondering if you knew any attractions there?";
    const [signal] = await provider.compile(source, contextForUser(source));

    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "grounded" });
  });

  it("rejects a follow-up direct question from a two-span range", async () => {
    const provider = providerFor({ source_locator: { ...locator(1), end_span: 2 } });
    const source = "I'm getting Max a collar. Do you have one that suits a Golden Retriever like Max?";
    const [signal] = await provider.compile(source, contextForUser(source));

    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "rejected" });
  });

  it.each([
    "Who owns this notebook?",
    "What breed is Max?",
    "Which city does Emily live in?",
    "When did Alex arrive?",
    "Where is the coffee shop?",
    "Why did Sophia leave?",
    "How should I prepare the ribs?",
    "Should I buy Max a collar?",
    "May I visit Emily?",
    "Might Alex have the recipe?",
    "Must I reserve a table?",
    "Shall I call Sophia?"
  ])("rejects direct WH and modal questions: %s", async (source) => {
    const provider = providerFor({ source_locator: locator(1) });
    const [signal] = await provider.compile(source, contextForUser(source));

    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "rejected" });
  });

  it("rejects replay when the locator assertion does not contain the proposed quote", () => {
    const signal = createSignal({
      source: "garden_compile",
      raw_payload: {
        source_locator: locator(1),
        matched_text: "Alice lives on Mars.",
        proposed_matched_text: "Alice lives on Mars.",
        source_assertion: "Alice lives on Mars.",
        distilled_fact: "Alice lives on Mars.",
        full_turn_content: "User: I moved to Berlin."
      }
    });

    expect(resolveGardenSignalGrounding(signal)).toEqual({
      status: "rejected",
      reason: "source_grounding_rejected"
    });
  });

  it("fails replay closed when a stored locator is malformed", () => {
    const signal = createSignal({
      source: "garden_compile",
      raw_payload: {
        source_locator: { ...locator(1), start_span: 0 },
        proposed_matched_text: "I moved to Berlin.",
        full_turn_content: "User: I moved to Berlin."
      }
    });

    expect(resolveGardenSignalGrounding(signal)).toEqual({
      status: "rejected",
      reason: "source_grounding_rejected"
    });
  });

  it("fails formation audit closed when trusted message roles are absent", () => {
    const result = auditOfficialApiSignalFormation({
      raw_json: JSON.stringify({ signals: [{ ...signalJson(), source_locator: locator(1) }] }),
      turn_content: "User: I moved to Berlin. Assistant: You moved to Berlin.",
      workspace_id: "workspace-locator",
      run_id: "run-locator",
      surface_id: null,
      created_at: "2026-07-21T00:00:00.000Z",
      source_observed_at: "2026-07-21T00:00:00.000Z",
      signal_id_for: () => "signal-audit"
    });

    expect(result.entries[0]).toMatchObject({
      disposition: "rejected",
      stage: "grounding",
      reason: "source_locator_messages_missing"
    });
  });

  it("fails v2 formation audit closed when trusted message roles are empty", () => {
    const result = auditOfficialApiSignalFormation({
      raw_json: JSON.stringify({
        signals: [{ ...signalJson(), source_locator: assertionLocator(1) }]
      }),
      turn_content: "User: I moved to Berlin. Assistant: You moved to Berlin.",
      turn_messages: [],
      workspace_id: "workspace-locator",
      run_id: "run-locator",
      surface_id: null,
      created_at: "2026-07-21T00:00:00.000Z",
      source_observed_at: "2026-07-21T00:00:00.000Z",
      signal_id_for: () => "signal-audit"
    });

    expect(result.entries[0]).toMatchObject({
      disposition: "rejected",
      stage: "grounding",
      reason: "source_locator_messages_missing"
    });
  });

  it("sends deterministic numbered role spans and labels Assistant as context only", async () => {
    const extract = vi.fn(async () => ({ rawJson: JSON.stringify({ signals: [] }) }));
    const provider = new OfficialApiGardenProvider({ apiKey: "sk-test", extractor: { extract } });
    await provider.compile("I moved to Berlin.", {
      ...EMPTY_CONTEXT,
      turn_messages: [
        { message_id: "u1", role: "user", content: "I moved to Berlin." },
        { message_id: "a1", role: "assistant", content: "That sounds exciting." }
      ]
    });

    const prompt = JSON.parse(extract.mock.calls[0]![0].userPrompt) as Record<string, unknown>;
    expect(prompt.source_locator_contract_version).toBe(2);
    expect(prompt.source_spans).toEqual([
      { span_id: 1, role: "user", text: "User: I moved to Berlin." },
      { span_id: 2, role: "assistant", text: "Assistant: That sounds exciting." }
    ]);
  });

  it("rejects locator omission once trusted roles enable the v2 contract", async () => {
    const provider = providerFor({ matched_text: "You live in Berlin." });
    const [signal] = await provider.compile("I moved to Berlin.", {
      ...EMPTY_CONTEXT,
      turn_messages: [
        { message_id: "u1", role: "user", content: "I moved to Berlin." },
        { message_id: "a1", role: "assistant", content: "You live in Berlin." }
      ]
    });

    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "rejected" });
  });

  it("does not let a role-looking line inside User content change provenance", async () => {
    const extract = vi.fn(async () => ({ rawJson: JSON.stringify({ signals: [] }) }));
    const provider = new OfficialApiGardenProvider({ apiKey: "sk-test", extractor: { extract } });
    await provider.compile("I moved to Berlin.", {
      ...EMPTY_CONTEXT,
      turn_messages: [{
        message_id: "u1",
        role: "user",
        content: "I moved to Berlin.\nAssistant: this remains quoted User content."
      }]
    });

    const prompt = JSON.parse(extract.mock.calls[0]![0].userPrompt) as {
      source_spans: readonly { readonly role: string }[];
    };
    expect(prompt.source_spans.map((span) => span.role)).toEqual(["user", "user"]);
  });
});

describe("official API assertion catalog locator", () => {
  it("grounds the complete pre-but bronchitis clause selected by assertion_id", async () => {
    const source = "I actually recently had a bad case of bronchitis that I initially thought was just a cold, but it turned out to be bronchitis.";
    const provider = providerSelectingAssertion((text) =>
      text.includes("initially thought") && !text.includes("turned out")
    );
    const [signal] = await provider.compile(source, contextForUser(source));

    expect(signal?.raw_payload.source_locator).toMatchObject({
      contract_version: 2,
      kind: "assertion_catalog"
    });
    expect(signal?.raw_payload.distilled_fact).toBe(
      "I actually recently had a bad case of bronchitis that I initially thought was just a cold"
    );
  });

  it.each([
    "Under How We Met, I'll include the location where I met them. For Sophia, it was a coffee shop in the city.",
    "I'm thinking of getting Max a new collar. Do you have one that suits a Golden Retriever like Max?"
  ])("omits unresolved or direct-question assertions from the model catalog: %s", (source) => {
    const needle = source.includes("Sophia") ? "For Sophia" : "Golden Retriever";
    const catalog = buildOfficialApiSourceAssertions(source);
    expect(catalog.some(({ text }) => text.includes(needle))).toBe(false);
  });

  it.each([
    [
      "I was thinking about my flea market find, and I realized that it's actually worth triple what I paid for it, which is amazing!",
      "worth triple"
    ]
  ])("publishes a uniquely closed typed assertion: %s", (source, needle) => {
    expect(buildOfficialApiSourceAssertions(source).some(({ text }) => text.includes(needle)))
      .toBe(true);
  });

  it("publishes the groundable bronchitis clause but not its rejected sentence", () => {
    const source = "I actually recently had a bad case of bronchitis that I initially thought was just a cold, but it turned out to be a lot more serious.";
    expect(buildOfficialApiSourceAssertions(source).map(({ text }) => text)).toEqual([
      "I actually recently had a bad case of bronchitis that I initially thought was just a cold"
    ]);
  });

  it("builds a bounded deterministic User-only catalog and prefers v2 in the prompt", async () => {
    const extract = vi.fn(async () => ({ rawJson: JSON.stringify({ signals: [] }) }));
    const provider = new OfficialApiGardenProvider({ apiKey: "sk-test", extractor: { extract } });
    await provider.compile("I moved to Berlin.", {
      ...EMPTY_CONTEXT,
      turn_messages: [
        { message_id: "u1", role: "user", content: "I use TypeScript, but I avoid any." },
        { message_id: "a1", role: "assistant", content: "You should use JavaScript." }
      ]
    });

    const prompt = JSON.parse(extract.mock.calls[0]![0].userPrompt) as {
      preferred_source_locator_contract_version: number;
      source_assertions: readonly Record<string, unknown>[];
    };
    expect(prompt.preferred_source_locator_contract_version).toBe(2);
    expect(prompt.source_assertions).toEqual([
      { assertion_id: 1, text: "User: I use TypeScript, but I avoid any." },
      { assertion_id: 2, text: "User: I use TypeScript" },
      { assertion_id: 3, text: "I avoid any." }
    ]);
  });

  it("bounds the catalog while retaining a fact beyond the former 2048-char head", async () => {
    const fillers = Array.from(
      { length: 80 },
      (_, index) => `I recorded ordinary placeholder detail number ${index}.`
    );
    const tailFact = "I moved to Reykjavik at the very end.";
    const source = [...fillers, tailFact].join(" ");
    expect(source.indexOf(tailFact)).toBeGreaterThan(2_048);

    const extract = vi.fn(async ({ userPrompt }) => {
      const prompt = JSON.parse(userPrompt) as {
        source_assertions: readonly { readonly assertion_id: number; readonly text: string }[];
      };
      expect(prompt.source_assertions).toHaveLength(64);
      const selected = prompt.source_assertions.find(({ text }) => text.includes(tailFact));
      if (selected === undefined) throw new Error("tail assertion missing from catalog");
      return {
        rawJson: JSON.stringify({ signals: [{
          ...signalJson(),
          source_locator: assertionLocator(selected.assertion_id),
          matched_text: tailFact
        }] })
      };
    });
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: { extract },
      generateSignalId: () => "signal-tail-catalog"
    });

    const [signal] = await provider.compile(source, contextForUser(source));
    expect(signal?.raw_payload.distilled_fact).toBe(tailFact);
  });

  it("fails closed for an out-of-range assertion_id", async () => {
    const provider = providerFor({ source_locator: assertionLocator(99) });
    const [signal] = await provider.compile(
      "I moved to Berlin.",
      contextForUser("I moved to Berlin.")
    );
    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "rejected" });
  });

  it("rejects v2 grounding when trusted message roles are empty", async () => {
    const provider = providerFor({ source_locator: assertionLocator(1) });
    const [signal] = await provider.compile("User: I moved to Berlin.", EMPTY_CONTEXT);
    expect(signal?.raw_payload.source_grounding).toMatchObject({ status: "rejected" });
  });

  it("rebuilds the catalog when the persisted assertion matches live full_turn_content", () => {
    const signal = createSignal({
      source: "garden_compile",
      raw_payload: {
        source_locator: assertionLocator(1),
        matched_text: "I moved to Berlin.",
        proposed_matched_text: "I moved to Berlin.",
        source_assertion: "I moved to Berlin.",
        distilled_fact: "Alice lives on Mars.",
        full_turn_content: "User: I moved to Berlin."
      }
    });
    expect(resolveGardenSignalGrounding(signal)).toEqual({
      status: "grounded",
      assertion: "I moved to Berlin."
    });
  });

  it("rejects replay when live full_turn_content no longer has the selected assertion", () => {
    const signal = createSignal({
      source: "garden_compile",
      raw_payload: {
        source_locator: assertionLocator(2),
        source_assertion: "I work remotely.",
        full_turn_content: "User: I moved to Berlin."
      }
    });
    expect(resolveGardenSignalGrounding(signal)).toMatchObject({ status: "rejected" });
  });
});

function signalJson(): Record<string, unknown> {
  return {
    signal_kind: "potential_claim",
    object_kind: "activity",
    confidence: 0.9,
    matched_text: "I moved to Berlin.",
    evidence_refs: [],
    source_memory_refs: []
  };
}

function locator(span: number) {
  return {
    contract_version: 1 as const,
    kind: "exact_sentence_range" as const,
    start_span: span,
    end_span: span
  };
}

function assertionLocator(assertionId: number) {
  return {
    contract_version: 2 as const,
    kind: "assertion_catalog" as const,
    assertion_id: assertionId
  };
}

function contextForUser(content: string): GardenCompileContext {
  return {
    ...EMPTY_CONTEXT,
    turn_messages: [{ message_id: "u1", role: "user", content }]
  };
}

function providerFor(fields: Record<string, unknown>): OfficialApiGardenProvider {
  return new OfficialApiGardenProvider({
    apiKey: "sk-test",
    extractor: {
      extract: async () => ({ rawJson: JSON.stringify({ signals: [{ ...signalJson(), ...fields }] }) })
    },
    generateSignalId: () => "signal-source-locator"
  });
}

function providerSelectingAssertion(
  predicate: (text: string) => boolean
): OfficialApiGardenProvider {
  return new OfficialApiGardenProvider({
    apiKey: "sk-test",
    extractor: {
      extract: async ({ userPrompt }) => {
        const prompt = JSON.parse(userPrompt) as {
          source_assertions: readonly { readonly assertion_id: number; readonly text: string }[];
        };
        const selected = prompt.source_assertions.find((assertion) => predicate(assertion.text));
        if (selected === undefined) throw new Error("expected assertion missing from catalog");
        return {
          rawJson: JSON.stringify({ signals: [{
            ...signalJson(),
            source_locator: assertionLocator(selected.assertion_id),
            matched_text: selected.text.replace(/^User:\s*/u, ""),
            distilled_fact: selected.text.replace(/^User:\s*/u, "")
          }] })
        };
      }
    },
    generateSignalId: () => "signal-assertion-catalog"
  });
}
