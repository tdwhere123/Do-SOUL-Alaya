import { afterAll, afterEach, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceSemanticReasoningResultSchema, sourceSemanticUndeliveredConclusion } from "@do-soul/alaya-protocol";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "../../../runs/semantic-chain/contract.js";
import { selectRecoveryNomination } from "../../../runs/semantic-chain/recovery-reason.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });

const KEY = "ab".repeat(32);
const digest = (byte: string) => `sha256:${byte.repeat(64)}`;

function frozenSource(sourceId: string) {
  return {
    rank: 1 as const, source_id: sourceId, source_version: "1", record_id: `record-${sourceId}`,
    content_digest: `sha256:${KEY}`, corpus_digest: KEY, source_observed_at: "2026-09-20T12:00:00.000Z",
    recorded_at: "2026-09-21T09:00:00.000Z", body_bytes: 12, read_bytes: 12, complete: false,
    initial_key: null, initial_cache_status: "missing" as const
  };
}

// Same schema-admitted computed control fixture as compact-reason-delivery.
function computedResult(overrides: Record<string, unknown> = {}) {
  // Full native responses have already crossed JSON; fixture omissions must not be explicit undefined.
  return SourceSemanticReasoningResultSchema.parse(JSON.parse(JSON.stringify({
    contract: "source-interpretation-reasoning-v5", outcome: { status: "interpreted", gaps: [] },
    consumed_leaves: [], source_interpretation_id: digest("1"), query_semantics_id: digest("2"),
    semantic_correspondence_id: digest("3"), conditional_computation_id: digest("4"),
    query_gaps: [{ kind: "unsupported_meaning", affected_ids: ["parcel"],
      support: [{ kind: "query_text", excerpt: "which parcel" }], description: "Inspection remains unresolved." }],
    semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation", world_claim: "unknown",
    ...overrides
  })));
}

type ReasonRound = Parameters<typeof selectRecoveryNomination>[2];
function persistNomination(response: unknown,
  status = "reasoned", window = [frozenSource("survivor")], rowIdentity: string | null = digest("1")) {
  const root = mkdtempSync(join(tmpdir(), "recovery-nomination-")); roots.push(root);
  const reasonPath = join(root, "initial-reason.json"), nominationPath = join(root, "source-nomination.json");
  const reason: ReasonRound = { identity: "reason", qualified_snapshot_identity: "publication",
    results: [{ ...(rowIdentity === null ? {} : { source_interpretation_id: rowIdentity }), status,
      response: response as { result?: unknown } }] };
  writeChainArtifact(reasonPath, reason);
  const nomination = selectRecoveryNomination(window, "publication", reason, window);
  writeChainArtifact(nominationPath, nomination);
  const bytes = readFileSync(nominationPath);
  const reopened = readChainArtifact(nominationPath);
  expect(reopened).toStrictEqual(nomination);
  const replayed = selectRecoveryNomination(window, "publication", readChainArtifact(reasonPath) as ReasonRound, window);
  expect(replayed).toStrictEqual(nomination);
  writeChainArtifact(nominationPath, replayed);
  expect(readFileSync(nominationPath)).toEqual(bytes);
  expect(chainIdentity(reopened)).toBe(chainIdentity(nomination));
  return { nomination, nominationPath };
}

it.each(["full result", "no_conclusion"])("persists missing-C preparation through %s without undefined controls", delivery => {
  const result = computedResult({ outcome: { status: "preparation_required", missing: "semantic_correspondence" },
    semantic_correspondence_id: undefined, conditional_computation_id: undefined, query_gaps: undefined,
    attention: { contract: "source-semantic-attention-v1", kind: "preparation",
      source_interpretation_id: digest("1"), query_semantics_id: digest("2"), source_id: "survivor",
      source_version: "1", content_digest: `sha256:${KEY}`, missing: "semantic_correspondence", observation: "not_executed" } });
  const response = delivery === "full result" ? { result } : sourceSemanticUndeliveredConclusion(result);
  const { nomination } = persistNomination(response, "preparation_required");
  expect(nomination).toMatchObject({ nomination: "frozen_window_after_unbound_reason", attention: null });
  expect(nomination.reason_controls).toStrictEqual([{
    outcome: { status: "preparation_required", missing: "semantic_correspondence" },
    source_interpretation_id: digest("1"), query_semantics_id: digest("2")
  }]);
});

it("persists a computed no_conclusion without inventing source target or attention", () => {
  const result = computedResult();
  const { nomination } = persistNomination(sourceSemanticUndeliveredConclusion(result));
  expect(nomination.nomination).toBe("frozen_window_after_computed_reason");
  expect(nomination.attention).toBeNull();
  expect(nomination.reason_controls).toStrictEqual([{
    outcome: result.outcome, source_interpretation_id: digest("1"), query_semantics_id: digest("2"),
    semantic_correspondence_id: digest("3"), conditional_computation_id: digest("4"), query_gaps: result.query_gaps
  }]);
  expect(nomination.reason_controls[0]).not.toHaveProperty("source_target");
});

it("preserves present target, explicit null, empty gaps and unknown attention instead of filtering falsy controls", () => {
  const source = frozenSource("attended");
  const result = computedResult({ outcome: { status: "unavailable", reason: "unknown" }, query_gaps: [],
    source_target: { kind: "source_evidence", workspace_id: "workspace", root_kind: "source_record",
      root_id: source.source_id, source_version: source.source_version, content_digest: source.content_digest,
      evidence_object_id: null },
    attention: { contract: "source-semantic-attention-v1", kind: "computed", source_id: source.source_id,
      source_version: source.source_version, content_digest: source.content_digest,
      source_interpretation_id: digest("1"), query_semantics_id: digest("2"),
      semantic_correspondence_id: digest("3"), conditional_computation_id: digest("4"),
      entries: [{ alternative: 0, frame: null, obligation: "branch", state: "unknown", observation: "unknown" }],
      truncated: false } });
  const { nomination } = persistNomination({ result }, "reasoned", [frozenSource("fallback"), source]);
  expect(nomination.source_id).toBe("attended");
  expect(nomination.nomination).toBe("initial_reason_attention");
  expect(nomination.attention).toStrictEqual(result.attention);
  expect(nomination.reason_controls[0]).toStrictEqual({ outcome: result.outcome,
    source_interpretation_id: digest("1"), query_semantics_id: digest("2"),
    semantic_correspondence_id: digest("3"), conditional_computation_id: digest("4"),
    source_target: result.source_target, query_gaps: [] });
  const compact = persistNomination(sourceSemanticUndeliveredConclusion(result), "reasoned", [frozenSource("fallback"), source]);
  expect(compact.nomination.source_id).toBe("fallback");
  expect(compact.nomination.attention).toBeNull();
  expect(compact.nomination.nomination).toBe("frozen_window_after_computed_reason");
});

it("keeps omitted controls distinct from empty gaps and retains the row H fallback", () => {
  const result = computedResult({ outcome: { status: "preparation_required", missing: "query_semantics_and_correspondence" },
    source_interpretation_id: undefined, query_semantics_id: undefined, semantic_correspondence_id: undefined,
    conditional_computation_id: undefined, query_gaps: undefined });
  const unbound = persistNomination({ result }, "preparation_required", undefined, null).nomination;
  expect(unbound.reason_controls).toStrictEqual([{ outcome: result.outcome }]);
  const absent = persistNomination({ result }, "preparation_required").nomination;
  expect(absent.reason_controls).toStrictEqual([{ outcome: result.outcome, source_interpretation_id: digest("1") }]);
  const empty = persistNomination({ result: { ...result, query_gaps: [] } }, "preparation_required").nomination;
  expect(empty.reason_controls).toStrictEqual([{ outcome: result.outcome, source_interpretation_id: digest("1"), query_gaps: [] }]);
  expect(chainIdentity(empty)).not.toBe(chainIdentity(absent));
});

it("still rejects a falsified persisted digest without changing global undefined identity semantics", () => {
  const { nominationPath } = persistNomination(sourceSemanticUndeliveredConclusion(computedResult()));
  const envelope = JSON.parse(readFileSync(nominationPath, "utf8"));
  envelope.identity = envelope.identity === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
  writeFileSync(nominationPath, JSON.stringify(envelope));
  expect(() => readChainArtifact(nominationPath)).toThrow("semantic chain artifact identity mismatch");
  expect(chainIdentity({ optional: undefined })).not.toBe(chainIdentity({}));
});
