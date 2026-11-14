import { describe, expect, it } from "vitest";
import {
  isGoldAuthorityFieldKey,
  omitGoldPrefixedFields
} from "../../../harness/seeding/compile-gold-fields.js";
import { projectCompileRawPayload } from "../../../harness/seeding/compile-raw-payload.js";
import { attachCompileSourceGrounding } from "../../../harness/seeding/source-grounding.js";
import type { BenchSignalSeedInput } from "../../../harness/daemon.js";

describe("compile gold field omission", () => {
  it("recursively omits gold authority aliases without deleting golden fields", () => {
    expect(omitGoldPrefixedFields({
      keep: true,
      gold_osf_ids: ["gold-1"],
      "gold-answer": "x",
      goldAnswer: "y",
      golden: true,
      golden_hint: "keep",
      nested: {
        gold_hint: "x",
        "gold-id": 1,
        goldHint: "z",
        keep: "yes",
        items: [{ gold_id: 1, goldId: 2, keep: 3 }]
      }
    })).toEqual({
      keep: true,
      golden: true,
      golden_hint: "keep",
      nested: { keep: "yes", items: [{ keep: 3 }] }
    });
    expect(omitGoldPrefixedFields({
      gold_semantic_factor_graph: { source_kind: "evidence" },
      "gold-osf-ids": ["gold-1"],
      goldOsfIds: ["gold-2"]
    })).toEqual({});
    expect(isGoldAuthorityFieldKey("golden")).toBe(false);
    expect(isGoldAuthorityFieldKey("goldenHint")).toBe(false);
  });

  it("strips top-level gold keys before a compiled payload can become a signal", () => {
    const payload = attachCompileSourceGrounding(
      {
        matched_text: ASSERTION,
        gold_osf_ids: ["gold-1"],
        "gold-answer": ASSERTION,
        goldAnswer: ASSERTION,
        semantic_factor_graph: sourceGraph(ASSERTION)
      },
      signalInput()
    );

    expect(payload).not.toHaveProperty("gold_osf_ids");
    expect(payload).not.toHaveProperty("gold-answer");
    expect(payload).not.toHaveProperty("goldAnswer");
    expect(payload.semantic_factor_graph).toMatchObject({ source_kind: "evidence" });
  });

  it("strips nested gold keys from compiled and projected payloads", () => {
    const nested = {
      matched_text: ASSERTION,
      source_grounding: {
        status: "grounded",
        gold_hint: "keep-out",
        "gold-hint": "keep-out",
        goldHint: "keep-out"
      },
      items: [{ gold_id: "nested", goldId: "nested", keep: true }],
      golden: { keep: true },
      semantic_factor_graph: sourceGraph(ASSERTION)
    };
    const compiled = attachCompileSourceGrounding(nested, signalInput());
    const projected = projectCompileRawPayload(nested);

    const nestedGoldKeys = ["gold_hint", "gold-hint", "goldHint", "gold_id", "goldId"] as const;
    assertAbsentKeys(compiled, nestedGoldKeys);
    assertAbsentKeys(projected, nestedGoldKeys);
    expect(compiled.items).toEqual([{ keep: true }]);
    expect(compiled.golden).toEqual({ keep: true });
    expect(compiled.semantic_factor_graph).toMatchObject({ source_kind: "evidence" });
  });

  it("does not rebuild a formed OSF from a gold-only payload", () => {
    const payload = attachCompileSourceGrounding(
      {
        matched_text: ASSERTION,
        gold_semantic_factor_graph: sourceGraph(ASSERTION),
        "gold-osf-ids": ["gold-1"],
        goldOsfIds: ["gold-2"],
        gold_answer: ASSERTION
      },
      signalInput()
    );

    expect(payload).not.toHaveProperty("gold_semantic_factor_graph");
    expect(payload).not.toHaveProperty("gold-osf-ids");
    expect(payload).not.toHaveProperty("goldOsfIds");
    expect(payload).not.toHaveProperty("gold_answer");
    expect(payload).not.toHaveProperty("semantic_factor_graph");
    expect(payload.semantic_factor_graph_projection).toEqual({
      status: "unavailable",
      reason: "semantic_factor_graph_missing"
    });
  });
});

const ASSERTION = "I prefer dark mode.";

function assertAbsentKeys(value: unknown, keys: readonly string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) assertAbsentKeys(item, keys);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    expect(record).not.toHaveProperty(key);
  }
  for (const child of Object.values(record)) {
    assertAbsentKeys(child, keys);
  }
}

function signalInput(): BenchSignalSeedInput {
  return {
    signalKind: "potential_claim",
    objectKind: "activity",
    confidence: 0.9,
    distilledFact: ASSERTION,
    turnContent: `User: ${ASSERTION}\nAssistant: Noted.`,
    matchedText: ASSERTION,
    evidenceRef: "message-1",
    turnSeedIndex: 0,
    extractionProvider: "official_api_compile"
  };
}

function sourceGraph(surface: string) {
  const semanticIdentity = surface.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  return {
    schema_version: 2 as const,
    source_kind: "evidence" as const,
    factors: [{
      factor_id: "fact",
      surface,
      semantic_identity: semanticIdentity
    }],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "fact-proposition",
      predicate_factor_id: "fact",
      arguments: [{
        position: 0,
        binding_identity: "fact",
        reference_kind: "factor" as const,
        reference_id: "fact"
      }]
    }]
  };
}
