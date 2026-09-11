import { describe, expect, it } from "vitest";
import {
  ASSOCIATION_DOMAIN_ID,
  FieldValueSchema,
  HARD_IDENTITY_TRANSFER_ID,
  HARD_IDENTITY_TRANSFER_VERSION,
  IDENTITY_NORMALIZATION_ID,
  IndexEntrySchema,
  InformationIndexSchema,
  MemorySearchResultSchema,
  PayloadContinuationRequestSchema,
  ProductStateKeySchema,
  ProductUpdateSchema,
  QueryInterpretationProposalSchema,
  QueryViewSchema,
  SoulMemorySearchRequestSchema,
  SoulReportContextUsageRequestSchema,
  SourceDeliveredSpanSchema,
  canonicalIndexEntryIdentity,
  canonicalProductIdentity,
  indexEntryObjectKind,
  indexEntrySubjectId,
  productStateKeyFromIndexEntry,
  memoryIndexEntry,
  memoryProductStateKey,
  retargetMemoryProduct,
  sameRecallTarget,
  sameSourceEvidenceRoot,
  sharedProductIdentity,
  sourceIndexEntry,
  sourceProductStateKey,
  sourceRecallTarget
} from "../../../index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SNAPSHOT = `sha256:${"b".repeat(64)}`;

describe("conditional-field product identity", () => {
  it("parses tagged memory and source-record-only product keys", () => {
    const memory = memoryProductStateKey({
      workspace_id: "ws",
      object_id: "mem-1",
      source_revision: "rev-1",
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    });
    expect(memory.target).toEqual({
      kind: "memory_entry",
      workspace_id: "ws",
      object_id: "mem-1",
      source_revision: "rev-1"
    });
    const source = sourceProductStateKey({
      workspace_id: "ws",
      root_kind: "source_record",
      root_id: "rec-1",
      source_version: "v1",
      content_digest: DIGEST,
      evidence_object_id: null,
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    });
    expect(source.target.kind).toBe("source_evidence");
    if (source.target.kind !== "source_evidence") return;
    expect(source.target.evidence_object_id).toBeNull();
    expect(canonicalProductIdentity(memory)).not.toBe(canonicalProductIdentity(source));
    expect(() => ProductStateKeySchema.parse({
      schema_version: 1,
      object_id: "mem-1",
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    })).toThrow();
  });

  it("keeps source-record-only index rows free of fabricated object ids", () => {
    const source = sourceIndexEntry({
      workspace_id: "ws",
      root_kind: "source_record",
      root_id: "rec-1",
      source_version: "v1",
      content_digest: DIGEST,
      evidence_object_id: null,
      association_milligrades: 600,
      program_state: "accepting",
      time_state: "as_of"
    });
    expect(source.object_id).toBeUndefined();
    expect(source.target.kind).toBe("source_evidence");
    expect(indexEntrySubjectId(source)).toBe("rec-1");
    expect(indexEntryObjectKind(source)).toBe("source_evidence");
    expect(() => IndexEntrySchema.parse({
      ...source,
      object_id: "fake-capsule"
    })).toThrow();
    const memory = memoryIndexEntry({
      workspace_id: "ws",
      object_id: "mem-1",
      source_revision: "rev-1",
      association_milligrades: 400,
      program_state: "accepting",
      time_state: "as_of"
    });
    expect(memory.object_id).toBe("mem-1");
    const encoded = MemorySearchResultSchema.parse({
      object_kind: "source_evidence",
      target: source.target,
      relevance_score: 0.6,
      content_preview: "quoted excerpt",
      evidence_pointers: [],
      selection_reason: "associated source",
      source_channels: ["conditional_field"],
      score_factors: { activation: 0.6, relevance: 0.6 },
      budget_state: {
        token_estimate: 1,
        max_entries: 1,
        max_total_tokens: 10,
        remaining_entries: 0,
        remaining_tokens: 0,
        within_budget: true
      }
    });
    expect(encoded.object_id).toBeUndefined();
    expect(encoded.object_kind).toBe("source_evidence");
    expect(() => MemorySearchResultSchema.parse({
      ...encoded,
      object_id: "fake-memory",
      object_kind: "memory_entry"
    })).toThrow();
    const measuredMemory = {
      object_id: "mem-1",
      target: {
        kind: "memory_entry" as const,
        workspace_id: "ws",
        object_id: "mem-1",
        source_revision: "rev-1"
      }
    };
    expect(indexEntrySubjectId(measuredMemory)).toBe("mem-1");
    expect(indexEntryObjectKind(measuredMemory)).toBe("memory_entry");
    const measuredSource = { object_id: "fake-capsule", target: source.target };
    expect(indexEntrySubjectId(measuredSource)).toBe("rec-1");
    expect(indexEntryObjectKind(measuredSource)).toBe("source_evidence");
    expect(indexEntrySubjectId({ target: source.target })).toBe("rec-1");
    expect(indexEntryObjectKind({ target: source.target })).toBe("source_evidence");
    const spanned = sourceIndexEntry({
      workspace_id: "ws",
      root_kind: "source_record",
      root_id: "rec-1",
      source_version: "v1",
      content_digest: DIGEST,
      evidence_object_id: null,
      association_milligrades: 600,
      program_state: "accepting",
      time_state: "as_of"
    });
    const withSpan = {
      ...spanned,
      target: sourceRecallTarget({
        workspace_id: "ws",
        root_kind: "source_record",
        root_id: "rec-1",
        source_version: "v1",
        content_digest: DIGEST,
        evidence_object_id: null,
        span: SourceDeliveredSpanSchema.parse({
          content_start: 0,
          content_end: 12,
          retained_extent: "excerpt",
          content_complete: false,
          original_complete: false
        })
      })
    };
    const reconstructed = productStateKeyFromIndexEntry(withSpan);
    expect(reconstructed.target.kind).toBe("source_evidence");
    if (reconstructed.target.kind === "source_evidence") {
      expect(reconstructed.target.span).toEqual(withSpan.target.span);
    }
    expect(reconstructed.program_state).toBe("accepting");
    expect(reconstructed.time_state).toBe("as_of");
    const omitted = { ...spanned, program_state: undefined, time_state: undefined };
    expect(productStateKeyFromIndexEntry(omitted).program_state).toBe("accepting");
    expect(canonicalIndexEntryIdentity(omitted)).toBe(canonicalIndexEntryIdentity({
      ...omitted,
      program_state: "accepting",
      time_state: "as_of"
    }));
    expect(() => retargetMemoryProduct(sourceProductStateKey({
      workspace_id: "ws",
      root_kind: "source_record",
      root_id: "rec-1",
      source_version: "v1",
      content_digest: DIGEST,
      evidence_object_id: null,
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    }), { object_id: "mem-1" })).toThrow(
      /memory_entry product/
    );
  });

  it("defaults enumeration policy and kind view and parses proposal and payload continuation", () => {
    const view = QueryViewSchema.parse({
      schema_version: 1,
      requested_roles: ["requested"]
    });
    expect(view.enumeration_policy).toBe("canonical");
    expect(view.result_kind_view).toBe("mixed");
    const proposal = QueryInterpretationProposalSchema.parse({
      schema_version: 1,
      original_query_digest: DIGEST,
      producer_id: "compiler.ordinary.v1"
    });
    expect(proposal.original_query_digest).toBe(DIGEST);
    expect(() => QueryInterpretationProposalSchema.parse({
      schema_version: 1,
      producer_id: "compiler.ordinary.v1"
    })).toThrow();
    const request = SoulMemorySearchRequestSchema.parse({
      query: "needle",
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: 5,
      enumeration_policy: "associative",
      cap_contracts: [{
        domain_id: ASSOCIATION_DOMAIN_ID,
        normalization: IDENTITY_NORMALIZATION_ID,
        transfer_id: HARD_IDENTITY_TRANSFER_ID,
        transfer_version: HARD_IDENTITY_TRANSFER_VERSION
      }],
      result_kind_view: "source_only",
      interpretation_proposal: proposal,
      payload_continuation: {
        schema_version: 1,
        purpose: "payload_expansion",
        target: {
          kind: "source_evidence",
          workspace_id: "ws",
          root_kind: "source_record",
          root_id: "rec-1",
          source_version: "v1",
          content_digest: DIGEST,
          evidence_object_id: null
        }
      }
    });
    expect(request.enumeration_policy).toBe("associative");
    expect(request.result_kind_view).toBe("source_only");
    expect(request.recent_turn).toBeUndefined();
    expect(PayloadContinuationRequestSchema.parse(request.payload_continuation).purpose)
      .toBe("payload_expansion");
    expect(ProductUpdateSchema.parse({
      schema_version: 1,
      product: memoryProductStateKey({
        workspace_id: "ws",
        object_id: "mem-1",
        source_revision: "rev-1",
        program_state: "accepting",
        hypothesis_id: "h0",
        binding_context: "default",
        time_state: "as_of"
      }),
      update_kind: "proof",
      revision: "rev-2"
    }).update_kind).toBe("proof");
  });

  it("accepts source usage with a delivered target and rejects forged or missing targets", () => {
    const target = {
      kind: "source_evidence" as const,
      workspace_id: "ws",
      root_kind: "source_record" as const,
      root_id: "rec-1",
      source_version: "v1",
      content_digest: DIGEST,
      evidence_object_id: null
    };
    expect(SoulReportContextUsageRequestSchema.parse({
      delivery_id: "delivery_1",
      usage_state: "used",
      delivered_objects: [{
        target,
        object_kind: "source_evidence",
        usage_status: "used"
      }]
    }).delivered_objects?.[0]?.target).toEqual(target);
    expect(() => SoulReportContextUsageRequestSchema.parse({
      delivery_id: "delivery_1",
      usage_state: "used",
      delivered_objects: [{
        target,
        object_id: "fake-capsule",
        object_kind: "source_evidence",
        usage_status: "used"
      }]
    })).toThrow();
    expect(() => SoulReportContextUsageRequestSchema.parse({
      delivery_id: "delivery_1",
      usage_state: "used",
      delivered_objects: [{
        usage_status: "used"
      }]
    })).toThrow();
    expect(SoulReportContextUsageRequestSchema.parse({
      delivery_id: "delivery_1",
      usage_state: "used",
      per_anchor_usage: [{
        target,
        object_kind: "source_evidence",
        anchor_role: "target"
      }]
    }).per_anchor_usage?.[0]?.target).toEqual(target);
    expect(() => SoulReportContextUsageRequestSchema.parse({
      delivery_id: "delivery_1",
      usage_state: "used",
      per_anchor_usage: [{
        object_kind: "source_evidence",
        anchor_role: "target"
      }]
    })).toThrow();
    expect(() => SoulReportContextUsageRequestSchema.parse({
      delivery_id: "delivery_1",
      usage_state: "used",
      per_anchor_usage: [{
        object_id: "fake-capsule",
        object_kind: "source_evidence",
        target,
        anchor_role: "target"
      }]
    })).toThrow();
    expect(() => SoulReportContextUsageRequestSchema.parse({
      delivery_id: "delivery_1",
      usage_state: "used",
      delivered_objects: [{
        object_kind: "memory_entry",
        usage_status: "used"
      }]
    })).toThrow();
    expect(SoulReportContextUsageRequestSchema.parse({
      delivery_id: "delivery_1",
      usage_state: "used",
      delivered_objects: [{
        target: {
          kind: "memory_entry",
          workspace_id: "ws",
          object_id: "mem-1",
          source_revision: "rev-1"
        },
        object_kind: "memory_entry",
        usage_status: "used"
      }]
    }).delivered_objects?.[0]?.object_id).toBeUndefined();
  });

  it("treats two delivered spans of the same source root as distinct identities", () => {
    const root = {
      workspace_id: "ws",
      root_kind: "source_record" as const,
      root_id: "rec-1",
      source_version: "v1",
      content_digest: DIGEST,
      evidence_object_id: null
    };
    const firstSpan = SourceDeliveredSpanSchema.parse({
      content_start: 0,
      content_end: 32,
      retained_extent: "body",
      content_complete: false,
      original_complete: true
    });
    const secondSpan = SourceDeliveredSpanSchema.parse({
      content_start: 32,
      content_end: 64,
      retained_extent: "body",
      content_complete: true,
      original_complete: true
    });
    const first = sourceRecallTarget({ ...root, span: firstSpan });
    const second = sourceRecallTarget({ ...root, span: secondSpan });
    const unspanned = sourceRecallTarget(root);
    expect(sameSourceEvidenceRoot(first, second)).toBe(true);
    expect(sameRecallTarget(first, second)).toBe(false);
    expect(sameRecallTarget(first, unspanned)).toBe(false);
    const firstProduct = sourceProductStateKey({
      ...root,
      span: firstSpan,
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    });
    const secondProduct = sourceProductStateKey({
      ...root,
      span: secondSpan,
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    });
    const rootProduct = sourceProductStateKey({
      ...root,
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    });
    expect(canonicalProductIdentity(firstProduct)).not.toBe(canonicalProductIdentity(secondProduct));
    expect(sharedProductIdentity(firstProduct)).toBe(sharedProductIdentity(secondProduct));
    expect(sharedProductIdentity(firstProduct)).toBe(sharedProductIdentity(rootProduct));
    const otherOrigin = sourceProductStateKey({
      ...root,
      root_id: "rec-2",
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    });
    expect(sharedProductIdentity(rootProduct)).not.toBe(sharedProductIdentity(otherOrigin));
    expect(() => SourceDeliveredSpanSchema.parse({
      ...firstSpan,
      content_start: 32,
      content_end: 16
    })).toThrow();
    expect(SoulReportContextUsageRequestSchema.parse({
      delivery_id: "delivery_1",
      usage_state: "used",
      delivered_objects: [{
        target: first,
        object_kind: "source_evidence",
        usage_status: "used"
      }, {
        target: second,
        object_kind: "source_evidence",
        usage_status: "used"
      }]
    }).delivered_objects?.map((object) => object.target)).toEqual([first, second]);
  });

  it("keeps preview-size-independent source identity on a public index", () => {
    const entry = sourceIndexEntry({
      workspace_id: "ws",
      root_kind: "source_record",
      root_id: "rec-1",
      source_version: "v1",
      content_digest: DIGEST,
      evidence_object_id: null,
      association_milligrades: 700,
      program_state: "accepting",
      time_state: "as_of"
    });
    const index = InformationIndexSchema.parse({
      schema_version: 1,
      query_id: "q1",
      snapshot_id: SNAPSHOT,
      result_version: "v1",
      entries: [entry],
      completeness: {
        schema_version: 1,
        logical_index: "complete",
        observed_coverage: "complete",
        transport: "complete",
        payload: "omitted",
        representation: "complete"
      },
      continuation: null,
      representation: {
        schema_version: 1,
        policy: "construct_index_then_page_then_payload",
        page_budget: 1,
        identity_tie_break: "serialization"
      },
      order_status: "complete",
      page_purpose: "membership"
    });
    expect(index.entries[0]?.target).toEqual(entry.target);
    expect(index.entries[0]?.object_id).toBeUndefined();
  });

  it("parses FieldValue reachable zero and unreachable without negative milligrades", () => {
    const state = memoryProductStateKey({
      workspace_id: "ws",
      object_id: "mem-1",
      source_revision: "rev",
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    });
    expect(FieldValueSchema.parse({
      schema_version: 1,
      state,
      milligrades: 0,
      accepting: true,
      activation: { kind: "reachable", milligrades: 0 }
    }).milligrades).toBe(0);
    expect(FieldValueSchema.parse({
      schema_version: 1,
      state,
      accepting: false,
      activation: { kind: "unreachable" }
    }).activation).toEqual({ kind: "unreachable" });
    expect(() => FieldValueSchema.parse({
      schema_version: 1,
      state,
      milligrades: -1,
      accepting: false
    })).toThrow();
  });
});
