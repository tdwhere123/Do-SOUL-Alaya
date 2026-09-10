import { describe, expect, it } from "vitest";
import {
  MemorySearchResultSchema,
  SoulMemorySearchResponseSchema,
  indexEntryCacheKey,
  sourceIndexEntry
} from "@do-soul/alaya-protocol";
import {
  RECALL_SOURCE_EVIDENCE_INCOMPATIBLE_MESSAGE,
  capableRecallConsumerDeclaration
} from "@do-soul/alaya-core";
import { createRecallHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import {
  encodeIndexResults,
  frameEncodedIndex,
  resolveMcpDegradationReason,
  selectRecallMcpHonestyDiagnostics
} from "../../../mcp-memory/recall/recall-result.js";

import { context, createDeps, stubRecallIndex } from "../tool/mcp-memory-tool-handler-fixture.js";

function memoryEntry(objectId = "memory-1") {
  return stubRecallIndex([objectId]).entries[0]!;
}

describe("conditional-field result encoding", () => {
  it("binds a clipped source span to final UTF-8 exposure", () => {
    const root = sourceIndexEntry({ workspace_id: "ws", root_kind: "source_record", root_id: "root",
      source_version: "v1", content_digest: `sha256:${"a".repeat(64)}`, evidence_object_id: null,
      association_milligrades: 1000, hypothesis_id: "h0", output_binding: "default", program_state: "accepting", time_state: "now" });
    const entry = { ...root, target: { ...root.target,
      span: { content_start: 0, content_end: 8, content_complete: true, original_complete: true, retained_extent: "body" as const } } };
    const index = { ...stubRecallIndex([]), entries: [entry] };
    const results = encodeIndexResults(index, new Map([[indexEntryCacheKey(entry), "😀😀"]]), 6);
    expect(results[0]?.content_preview).toBe("😀");
    expect(results[0]?.target).toMatchObject({ span: { content_start: 0, content_end: 4, content_complete: false } });
    const framed = frameEncodedIndex(index, results);
    expect(framed.entries[0]?.target).toEqual(results[0]?.target);
    expect(framed.completeness.payload).toBe("partial");
  });
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
      query: "needle", max_results: 5, scope_class: null, dimension: null, domain_tags: null,
      ...capableRecallConsumerDeclaration()
    }, context)).rejects.toThrow(/requires an authoritative index/);
    expect(deps.trustStateRecorder.recordDelivery).not.toHaveBeenCalled();
  });

  it("encodes only the authoritative index in product order", () => {
    const index = {
      ...stubRecallIndex([]),
      entries: [{
        ...memoryEntry(),
        association_milligrades: 500,
        role: "requested" as const,
        hypothesis_id: "h1",
        program_state: "accepting",
        time_state: "present",
        output_binding: "memory-1"
      }],
      representation: { ...stubRecallIndex([]).representation, page_budget: 1 }
    };
    const results = encodeIndexResults(index, new Map([["memory-1", "Recall content"]]));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      object_id: "memory-1",
      hypothesis_id: "h1",
      program_state: "accepting",
      time_state: "present",
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
        ...memoryEntry(),
        hypothesis_id: "h1",
        output_binding: "memory-1",
        role: "requested" as const,
        association_milligrades: 500,
        program_state: "accepting",
        time_state: "present"
      }],
      representation: { ...stubRecallIndex([]).representation, page_budget: 1 }
    };
    const results = encodeIndexResults(index, new Map([["memory-1", "too large"]]), 1);
    expect(results).toHaveLength(1);
    expect(results[0]?.object_id).toBe(index.entries[0]?.object_id);
    expect(results[0]?.content_preview).toBe("[payload omitted]");
    expect(frameEncodedIndex(index, results).entries).toEqual(index.entries);
    expect(frameEncodedIndex(index, results).completeness.payload).toBe("omitted");
  });

  it("truncates the first preview to fit remaining tokens instead of omitting the row", () => {
    const index = {
      ...stubRecallIndex([]),
      entries: [{
        ...memoryEntry(),
        hypothesis_id: "h1",
        output_binding: "memory-1",
        role: "requested" as const,
        association_milligrades: 500,
        program_state: "accepting",
        time_state: "present"
      }],
      representation: { ...stubRecallIndex([]).representation, page_budget: 1 }
    };
    const preview = "x".repeat(3_000);
    const results = encodeIndexResults(index, new Map([["memory-1", preview]]), 2_000);
    expect(results).toHaveLength(1);
    expect(results[0]?.object_id).toBe("memory-1");
    expect(results[0]?.content_preview.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.content_preview.length).toBeLessThan(preview.length);
    expect(results[0]?.budget_state.within_budget).toBe(true);
    expect(results[0]?.budget_state.token_estimate).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(results[0]!.content_preview, "utf8")).toBeLessThanOrEqual(2_000);
    expect(frameEncodedIndex(index, results).entries).toEqual(index.entries);
  });

  it("encodes a source-record-only index row with its native target and no fake memory id", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const entry = sourceIndexEntry({
      workspace_id: "ws",
      root_kind: "source_record",
      root_id: "rec-1",
      source_version: "v1",
      content_digest: digest,
      evidence_object_id: null,
      association_milligrades: 700,
      hypothesis_id: "h1",
      output_binding: "default",
      program_state: "accepting",
      time_state: "present"
    });
    const index = {
      ...stubRecallIndex([]),
      entries: [entry],
      representation: { ...stubRecallIndex([]).representation, page_budget: 1 }
    };
    const results = encodeIndexResults(index, new Map([[
      // keyed by canonical identity in production; object_id fallback must not invent a memory id
      "rec-1",
      "quoted source excerpt"
    ]]));
    expect(results).toHaveLength(1);
    const parsed = MemorySearchResultSchema.parse(results[0]);
    expect(parsed.object_kind).toBe("source_evidence");
    expect(parsed.object_id).toBeUndefined();
    expect(parsed.target).toEqual(entry.target);
    expect(parsed.object_kind).not.toBe("memory_entry");
  });

  it("rejects an undeclared mixed consumer before execute instead of emitting source rows", async () => {
    const deps = createDeps();
    const handler = createRecallHandler({
      deps,
      now: () => "2026-09-08T00:00:00.000Z",
      generateId: () => "00000000-0000-4000-8000-000000000001",
      warn: () => undefined
    });
    await expect(handler({
      query: "needle", max_results: 5, scope_class: null, dimension: null, domain_tags: null
    }, context)).rejects.toThrow(RECALL_SOURCE_EVIDENCE_INCOMPATIBLE_MESSAGE);
    expect(deps.recallService.recall).not.toHaveBeenCalled();
  });

  it("executes mixed recall when the consumer declares source_evidence support", async () => {
    const deps = createDeps();
    const handler = createRecallHandler({
      deps,
      now: () => "2026-09-08T00:00:00.000Z",
      generateId: () => "00000000-0000-4000-8000-000000000001",
      warn: () => undefined
    });
    const response = await handler({
      query: "needle",
      max_results: 5,
      scope_class: null,
      dimension: null,
      domain_tags: null,
      ...capableRecallConsumerDeclaration()
    }, context);
    expect(deps.recallService.recall).toHaveBeenCalled();
    expect(response.results.every((row) => row.object_kind === "memory_entry" || row.object_kind === "source_evidence"))
      .toBe(true);
  });

  it("allows explicit memory_only without source_evidence support", async () => {
    const deps = createDeps();
    const handler = createRecallHandler({
      deps,
      now: () => "2026-09-08T00:00:00.000Z",
      generateId: () => "00000000-0000-4000-8000-000000000001",
      warn: () => undefined
    });
    await handler({
      query: "needle",
      max_results: 5,
      scope_class: null,
      dimension: null,
      domain_tags: null,
      result_kind_view: "memory_only"
    }, context);
    expect(deps.recallService.recall).toHaveBeenCalledWith(
      expect.objectContaining({ result_kind_view: "memory_only" })
    );
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
