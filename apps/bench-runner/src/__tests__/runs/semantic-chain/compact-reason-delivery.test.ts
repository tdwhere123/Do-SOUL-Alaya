import { afterAll, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });

import {
  SourceSemanticReasoningResultSchema, sourceSemanticReasonControl, sourceSemanticUndeliveredConclusion
} from "@do-soul/alaya-protocol";
import { selectRecoveryNomination } from "../../../runs/semantic-chain/recovery-reason.js";

const KEY = "ab".repeat(32);
const DIGEST = (byte: string) => `sha256:${byte.repeat(64)}`;

function frozenSource(sourceId: string) {
  return {
    rank: 1 as const, source_id: sourceId, source_version: "1", record_id: `record-${sourceId}`,
    content_digest: `sha256:${KEY}`, corpus_digest: KEY, source_observed_at: "2026-09-20T12:00:00.000Z",
    recorded_at: "2026-09-21T09:00:00.000Z", body_bytes: 12, read_bytes: 12, complete: false,
    initial_key: null, initial_cache_status: "missing" as const
  };
}

function computedResult() {
  return SourceSemanticReasoningResultSchema.parse({
    contract: "source-interpretation-reasoning-v5",
    outcome: { status: "interpreted", gaps: [] },
    consumed_leaves: [],
    source_interpretation_id: DIGEST("1"), query_semantics_id: DIGEST("2"),
    semantic_correspondence_id: DIGEST("3"), conditional_computation_id: DIGEST("4"),
    query_gaps: [{ kind: "unsupported_meaning", affected_ids: ["parcel"],
      support: [{ kind: "query_text", excerpt: "which parcel" }],
      description: "Inspection remains unresolved." }],
    semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation", world_claim: "unknown"
  });
}

it("round-trips a computed no_conclusion receipt without fabricating attention", () => {
  const result = computedResult();
  const receipt = sourceSemanticUndeliveredConclusion(result);
  const roundtrip = JSON.parse(JSON.stringify(receipt)) as typeof receipt;
  const control = sourceSemanticReasonControl(roundtrip);
  expect(roundtrip).toEqual(receipt);
  expect(control.outcome).toEqual(result.outcome);
  expect(control.query_gaps).toEqual(result.query_gaps);
  expect(control.conditional_computation_id).toBe(result.conditional_computation_id);
  expect(control.source_interpretation_id).toBe(result.source_interpretation_id);
  expect(control.query_semantics_id).toBe(result.query_semantics_id);
  expect(control.semantic_correspondence_id).toBe(result.semantic_correspondence_id);
  expect(control.attention).toBeUndefined();
  expect(control.source_target).toBeUndefined();
  expect(() => sourceSemanticReasonControl({ outcome: result.outcome })).toThrow();
  expect(() => sourceSemanticReasonControl({ result: { outcome: result.outcome } })).toThrow();
});

it("nominates a computed undelivered conclusion as computed-not-delivered, not unbound", () => {
  const survivor = frozenSource("survivor");
  const result = computedResult();
  const roundtrip = JSON.parse(JSON.stringify(sourceSemanticUndeliveredConclusion(result))) as ReturnType<
    typeof sourceSemanticUndeliveredConclusion>;
  const nominated = selectRecoveryNomination([survivor], "publication", {
    identity: "reason", qualified_snapshot_identity: "publication",
    results: [{ source_interpretation_id: result.source_interpretation_id, status: "reasoned",
      response: roundtrip as { result?: unknown } }]
  }, [survivor]);
  expect(nominated.nomination).toBe("frozen_window_after_computed_reason");
  expect(nominated.attention).toBeNull();
  expect(nominated.reason_controls).toEqual([{
    source_interpretation_id: result.source_interpretation_id,
    query_semantics_id: result.query_semantics_id,
    semantic_correspondence_id: result.semantic_correspondence_id,
    conditional_computation_id: result.conditional_computation_id,
    outcome: result.outcome, source_target: undefined, query_gaps: result.query_gaps
  }]);
});

it("keeps an explicit no_conclusion without computation identity unbound rather than blank", () => {
  const survivor = frozenSource("survivor");
  const result = SourceSemanticReasoningResultSchema.parse({
    contract: "source-interpretation-reasoning-v5",
    outcome: { status: "preparation_required", missing: "query_semantics_and_correspondence" },
    consumed_leaves: [], semantic_status: "unreviewed",
    conclusion_scope: "conditional_on_interpretation", world_claim: "unknown"
  });
  const roundtrip = JSON.parse(JSON.stringify(sourceSemanticUndeliveredConclusion(result))) as ReturnType<
    typeof sourceSemanticUndeliveredConclusion>;
  const nominated = selectRecoveryNomination([survivor], "publication", {
    identity: "reason", qualified_snapshot_identity: "publication",
    results: [{ status: "reasoned", response: roundtrip as { result?: unknown } }]
  }, [survivor]);
  expect(nominated.nomination).toBe("frozen_window_after_unbound_reason");
  expect(nominated.attention).toBeNull();
  expect(nominated.reason_controls[0]).toMatchObject({
    outcome: result.outcome
  });
  expect(nominated.reason_controls[0]).not.toHaveProperty("conditional_computation_id");
  expect(sourceSemanticReasonControl(roundtrip).conditional_computation_id).toBeUndefined();
});
