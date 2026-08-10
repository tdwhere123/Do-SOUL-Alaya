import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BoundedJsonObjectSchema } from "@do-soul/alaya-protocol";
import { BOUNDED_JSON_OBJECT_MAX_CHARS } from "../../../../../../packages/protocol/src/shared/schema-primitives.js";
import {
  isRawPayloadBoundError,
  projectCompileRawPayload
} from "../../../harness/seeding/compile-raw-payload.js";

describe("compile raw payload projection", () => {
  it("hashes equivalent source objects deterministically while retaining semantic keys", () => {
    const semanticFactorGraph = semanticGraph();
    const factFrame = {
      schema_version: 1,
      slots: [
        { role: "subject", text: "I" },
        { role: "relation", text: "use" },
        { role: "value", text: "Atlas" }
      ]
    };
    const sourceLocator = {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: 1
    };
    const verifiedSourceHash =
      `sha256:garden-verified-user-assertion-v1:${"a".repeat(64)}`;
    const first = projectCompileRawPayload({
      provider_diagnostics: "x".repeat(14_000),
      temporal_projection: { time_precision: "day", event_time_start: "2026-07-10" },
      matched_text: "durable fact",
      canonical_entities: ["source"],
      source_locator: sourceLocator,
      verified_user_assertion_source_hash: verifiedSourceHash,
      semantic_factor_graph: semanticFactorGraph,
      fact_frame: factFrame
    });
    const reordered = projectCompileRawPayload({
      canonical_entities: ["source"],
      fact_frame: factFrame,
      matched_text: "durable fact",
      semantic_factor_graph: semanticFactorGraph,
      source_locator: sourceLocator,
      temporal_projection: { event_time_start: "2026-07-10", time_precision: "day" },
      provider_diagnostics: "x".repeat(14_000),
      verified_user_assertion_source_hash: verifiedSourceHash
    });

    expect(first.bench_source_raw_payload_sha256).toBe(
      reordered.bench_source_raw_payload_sha256
    );
    expect(first).toMatchObject({
      matched_text: "durable fact",
      canonical_entities: ["source"],
      temporal_projection: { event_time_start: "2026-07-10", time_precision: "day" },
      source_locator: sourceLocator,
      verified_user_assertion_source_hash: verifiedSourceHash,
      semantic_factor_graph: semanticFactorGraph,
      fact_frame: factFrame,
      bench_source_raw_payload_projected: true,
      bench_source_raw_payload_key_count: 8
    });
    expect(first).not.toHaveProperty("provider_diagnostics");
  });

  it("uses locale-independent code-unit ordering for the source digest", () => {
    const projected = projectCompileRawPayload({ "ä": 1, z: 2 });
    expect(projected.bench_source_raw_payload_sha256).toBe(
      "sha256:896b8dd27b9b539d56c30c96acce8910a2293d7bef3fc3ef87195bc2eb778073"
    );
  });

  it.each([
    "semantic_factor_graph_invalid_reference",
    "semantic_factor_graph_not_source_grounded"
  ] as const)("retains a validated semantic projection failure audit: %s", (reason) => {
    const projected = projectCompileRawPayload({
      semantic_factor_graph_projection: {
        status: "rejected",
        reason
      }
    });

    expect(projected.semantic_factor_graph_projection).toEqual({
      status: "rejected",
      reason
    });
  });

  it("recognizes only the raw-payload serialized-size validation failure", () => {
    expect(isRawPayloadBoundError({
      issues: [{ path: ["raw_payload"], message: "JSON object must serialize to at most 16384 characters." }]
    })).toBe(true);
    expect(isRawPayloadBoundError({
      issues: [{ path: ["confidence"], message: "Too big" }]
    })).toBe(false);
  });

  it("fits correlated retained maxima within the protocol raw-payload bound", () => {
    const profile = maximalPreferenceProfile();
    const projected = projectCompileRawPayload({
      matched_text: "m".repeat(1_024),
      distilled_fact: "d".repeat(2_048),
      source_assertion: "s".repeat(2_048),
      proposed_matched_text: "p".repeat(1_024),
      proposed_distilled_fact: "q".repeat(2_048),
      full_turn_content: "f".repeat(2_048),
      turn_content_excerpt: "e".repeat(256),
      provider_kind: "k".repeat(200),
      extraction_reason: "r".repeat(400),
      extracted_object_kind: "o".repeat(200),
      extraction_provider: "v".repeat(200),
      canonical_entities: ["a".repeat(512), "b".repeat(512), "c".repeat(512)],
      temporal_projection: {
        projection_schema_version: 1,
        event_time_start: "1".repeat(64),
        event_time_end: "2".repeat(64),
        valid_from: "3".repeat(64),
        valid_to: "4".repeat(64),
        time_precision: "5".repeat(64),
        time_source: "6".repeat(64)
      },
      preference_profile: profile,
      source_grounding: {
        version: 1,
        status: "grounded",
        content_basis: "source_assertion",
        source_assertion: "s".repeat(2_048),
        proposed_matched_text: "p".repeat(2_048),
        reasons: Array.from({ length: 8 }, (_, index) => `${index}`.repeat(128)),
        proposed_preference_profile: profile
      }
    });

    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(
      BOUNDED_JSON_OBJECT_MAX_CHARS
    );
    expect(BoundedJsonObjectSchema.safeParse(projected).success).toBe(true);
    expect(projected.source_grounding).toMatchObject({
      version: 1,
      status: "grounded",
      content_basis: "source_assertion",
      source_assertion: "s".repeat(2_048)
    });
  });

  it("leaves an exact digest when a complete long preference proposal is omitted", () => {
    const proposedPreference = maximalPreferenceProfile();
    const projected = projectCompileRawPayload({
      matched_text: "m".repeat(1_024),
      distilled_fact: "d".repeat(2_048),
      full_turn_content: "f".repeat(2_048),
      preference_profile: proposedPreference,
      source_grounding: {
        version: 1,
        status: "grounded",
        content_basis: "source_assertion",
        source_assertion: "s".repeat(2_048),
        proposed_matched_text: "p".repeat(1_024),
        proposed_preference_profile: proposedPreference,
        reasons: []
      }
    });
    const grounding = projected.source_grounding as Record<string, unknown>;

    expect(grounding).not.toHaveProperty("proposed_preference_profile");
    expect(grounding.proposed_preference_profile_sha256).toBe(
      canonicalDigest(proposedPreference)
    );
    expect(grounding.reasons).toContain(
      "proposed_preference_profile_omitted_for_payload_bound"
    );
  });

  it("drops oversized semantic projections last while retaining source authority", () => {
    const sourceLocator = {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: 7
    };
    const verifiedSourceHash =
      `sha256:garden-verified-user-assertion-v1:${"b".repeat(64)}`;
    const projected = projectCompileRawPayload({
      source_locator: sourceLocator,
      verified_user_assertion_source_hash: verifiedSourceHash,
      semantic_factor_graph: maximalSemanticGraph()
    });

    expect(BoundedJsonObjectSchema.safeParse(projected).success).toBe(true);
    expect(projected).toMatchObject({
      source_locator: sourceLocator,
      verified_user_assertion_source_hash: verifiedSourceHash,
      bench_source_raw_payload_omitted_projections: ["semantic_factor_graph"]
    });
    expect(projected).not.toHaveProperty("semantic_factor_graph");
  });
});

function maximalPreferenceProfile(): Readonly<Record<string, unknown>> {
  return {
    projection_schema_version: 1,
    preference_subject: "s".repeat(1_024),
    preference_predicate: "p".repeat(1_024),
    preference_object: "o".repeat(1_024),
    preference_category: "c".repeat(1_024),
    preference_polarity: "n".repeat(1_024)
  };
}

function canonicalDigest(value: Readonly<Record<string, unknown>>): string {
  const canonical = Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

function semanticGraph(): Readonly<Record<string, unknown>> {
  return {
    schema_version: 1,
    source_kind: "evidence",
    factors: [
      { factor_id: "actor", surface: "I", semantic_identity: "speaker" },
      { factor_id: "predicate", surface: "use", semantic_identity: "use" },
      { factor_id: "object", surface: "Atlas", semantic_identity: "atlas" }
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        {
          position: 0,
          binding_identity: "agent",
          reference_kind: "factor",
          reference_id: "actor"
        },
        {
          position: 1,
          binding_identity: "object",
          reference_kind: "factor",
          reference_id: "object"
        }
      ]
    }]
  };
}

function maximalSemanticGraph(): Readonly<Record<string, unknown>> {
  const factors = Array.from({ length: 32 }, (_, index) => ({
    factor_id: `factor-${index}`,
    surface: "S".repeat(512),
    semantic_identity: "s".repeat(512)
  }));
  const propositions = Array.from({ length: 4 }, (_, propositionIndex) => ({
    proposition_id: `proposition-${propositionIndex}`,
    predicate_factor_id: `factor-${propositionIndex * 8}`,
    arguments: Array.from({ length: 8 }, (_, position) => ({
      position,
      binding_identity: `binding-${position}`,
      reference_kind: "factor",
      reference_id: `factor-${propositionIndex * 8 + position}`
    }))
  }));
  return {
    schema_version: 1,
    source_kind: "evidence",
    factors,
    variables: [],
    result_variable_ids: [],
    propositions
  };
}
