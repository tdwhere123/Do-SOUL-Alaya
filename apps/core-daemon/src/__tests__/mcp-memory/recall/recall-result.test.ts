import { describe, expect, it } from "vitest";
import { SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import { createRecallHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import {
  encodeIndexResults,
  frameEncodedIndex,
  resolveMcpDegradationReason,
  selectRecallMcpHonestyDiagnostics
} from "../../../mcp-memory/recall/recall-result.js";

import { context, createDeps, stubRecallIndex } from "../tool/mcp-memory-tool-handler-fixture.js";

describe("conditional-field result encoding", () => {
  it("rejects a missing authoritative index before recording any delivery", async () => {
    const deps = createDeps();
    const recall = deps.recallService.recall;
    deps.recallService.recall = async (input) => {
      const malformed = { ...await recall(input) };
      Reflect.deleteProperty(malformed, "index");
      return malformed;
    };
    const handler = createRecallHandler({
      deps,
      now: () => "2026-09-08T00:00:00.000Z",
      generateId: () => "00000000-0000-4000-8000-000000000001",
      warn: () => undefined
    });
    await expect(handler({
      query: "needle", max_results: 5, scope_class: null, dimension: null, domain_tags: null
    }, context)).rejects.toThrow(/requires an authoritative index/);
    expect(deps.trustStateRecorder.recordDelivery).not.toHaveBeenCalled();
  });

  it("encodes only the authoritative index in product order", () => {
    const index = {
      ...stubRecallIndex([]),
      entries: [{
        object_id: "memory-1",
        association_milligrades: 500,
        schema_version: 1 as const,
        claim: "unknown" as const,
        role: "requested" as const,
        explanation_ids: [],
        hypothesis_id: "h1",
        program_state: "accept",
        output_binding: "memory-1"
      }],
      representation: { ...stubRecallIndex([]).representation, page_budget: 1 }
    };
    const results = encodeIndexResults(index, new Map([["memory-1", "Recall content"]]));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      object_id: "memory-1",
      hypothesis_id: "h1",
      program_state: "accept",
      output_binding: "memory-1",
      source_channels: ["conditional_field"],
      evidence_pointers: []
    });
    expect(results[0]?.selection_reason).not.toContain("fusion");
    expect(frameEncodedIndex(index, results)).toBe(index);
  });

  it("preserves the index and exposes payload omission when encoding cannot fit", () => {
    const index = {
      ...stubRecallIndex([]),
      entries: [{
        schema_version: 1 as const, object_id: "memory-1", hypothesis_id: "h1",
        output_binding: "memory-1", role: "requested" as const, explanation_ids: [],
        association_milligrades: 500, claim: "unknown" as const
      }],
      representation: { ...stubRecallIndex([]).representation, page_budget: 1 }
    };
    const results = encodeIndexResults(index, new Map([["memory-1", "too large"]]), 1);
    expect(results).toEqual([]);
    expect(frameEncodedIndex(index, results).entries).toEqual(index.entries);
    expect(frameEncodedIndex(index, results).completeness.payload).toBe("omitted");
  });
});

describe("resolveMcpDegradationReason", () => {
  it("maps provider_missing and no_stored_vectors to non-null MCP degradation_reason", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "provider_missing"
          }
        },
        false
      )
    ).toBe("provider_missing");

    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "not_attempted",
            provider_degradation_reason: "no_stored_vectors"
          }
        },
        false
      )
    ).toBe("no_stored_vectors");
  });

  it("maps provider unavailable/failed diagnostics without leaving null", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "requested",
            provider_degradation_reason: "provider_unavailable"
          }
        },
        false
      )
    ).toBe("provider_unavailable");

    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "requested",
            embedding_provider_status: "provider_failed"
          }
        },
        false
      )
    ).toBe("provider_failed");
  });

  it("maps query_embedding_unusable to MCP provider_failed instead of null", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "requested",
            embedding_provider_status: "query_embedding_unusable",
            provider_degradation_reason: "query_embedding_unusable"
          }
        },
        false
      )
    ).toBe("provider_failed");

    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "requested",
            embedding_provider_status: "query_embedding_unusable"
          }
        },
        false
      )
    ).toBe("provider_failed");
  });

  it("does not invent degradation when embedding was intentionally disabled", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "disabled",
            embedding_provider_status: "provider_not_requested",
            provider_degradation_reason: null
          }
        },
        false
      )
    ).toBeNull();
  });

  it("does not invent provider_unavailable from provider_warmup_pending when embedding is disabled", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "disabled",
            provider_degradation_reason: "provider_warmup_pending"
          }
        },
        false
      )
    ).toBeNull();
  });

  it("still surfaces hard embedding failures when supplement status is disabled", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "disabled",
            provider_degradation_reason: "query_embedding_failed"
          }
        },
        false
      )
    ).toBe("provider_failed");
  });

  it("does not invent MCP degradation_reason for unknown provider_degradation_reason strings", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "requested",
            provider_degradation_reason: "totally_unknown_diagnostic"
          }
        },
        false
      )
    ).toBeNull();
  });

  it("preserves cascade degradation_reason over embedding mapping", () => {
    expect(
      resolveMcpDegradationReason(
        {
          degradation_reason: "cold_cascade_engaged",
          diagnostics: {
            embedding_supplement_status: "provider_missing"
          }
        },
        false
      )
    ).toBe("cold_cascade_engaged");
  });

  it("emits schema-valid SoulMemorySearchResponse degradation_reason values", () => {
    for (const reason of [
      "provider_missing",
      "provider_unavailable",
      "provider_failed",
      "no_stored_vectors"
    ] as const) {
      const parsed = SoulMemorySearchResponseSchema.parse({
        delivery_id: "delivery-1",
        results: [],
        total_count: 0,
        strategy_mix: {
          deterministic_match: true,
          precomputed_rank: true,
          semantic_supplement: false,
          graph_support: false,
          path_plasticity: false,
          global_recall: false
        },
        degradation_reason: reason
      });
      expect(parsed.degradation_reason).toBe(reason);
    }
  });
});

describe("selectRecallMcpHonestyDiagnostics", () => {
  it("keeps embedding honesty fields and drops candidate dumps", () => {
    const honesty = selectRecallMcpHonestyDiagnostics({
      embedding_supplement_status: "requested",
      embedding_provider_status: "provider_ready",
      provider_degradation_reason: null,
      candidates: [{ candidate_key: "should-not-leak" }],
      fusion_breakdown: [{ candidate_key: "should-not-leak" }]
    } as Parameters<typeof selectRecallMcpHonestyDiagnostics>[0] & {
      readonly candidates: readonly unknown[];
      readonly fusion_breakdown: readonly unknown[];
    });
    expect(honesty).toEqual({
      embedding_supplement_status: "requested",
      embedding_provider_status: "provider_ready",
      provider_degradation_reason: null
    });
    expect(honesty).not.toHaveProperty("candidates");
    expect(honesty).not.toHaveProperty("fusion_breakdown");
  });

  it("returns null when recall diagnostics are absent", () => {
    expect(selectRecallMcpHonestyDiagnostics(undefined)).toBeNull();
    expect(selectRecallMcpHonestyDiagnostics(null)).toBeNull();
  });
});
