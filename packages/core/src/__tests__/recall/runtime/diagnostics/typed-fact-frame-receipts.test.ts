import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
  evidenceFactFrameFormationCapturePreimage,
  type AssociativeFactSlot,
  type EvidenceFactFrameFormationCapture,
  type EvidenceFactFrameFormationCaptureBody
} from "@do-soul/alaya-protocol";
import { buildRecallCandidateDedupeKey } from
  "../../../../recall/runtime/recall-service-helpers.js";
import { buildCaptureProofDiagnostics } from
  "../../../../recall/runtime/diagnostics/capture-proof-diagnostics.js";
import { copyTypedFactFrameReceiptsFromFormations } from
  "../../../../recall/runtime/diagnostics/capture-proof/typed-fact-frame-receipts.js";
import { CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID } from
  "../../../../recall/delivery/fine-assessment-selection/content-owned-fact-key.js";
import { buildRecallDiagnostics } from "../../../../recall/runtime/diagnostics.js";
import { materializeFineAssessmentSelectionBoundary } from
  "../../../../recall/delivery/selection-boundary/selection-boundary-capture.js";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../../../recall/delivery/selection-boundary/selection-boundary-types.js";
import type { CaptureProofDiagnostics } from
  "../../../../recall/runtime/diagnostics/capture-proof-diagnostics.js";
import {
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap,
  selectCandidates
} from "../../fine-assessment-selection-fixtures.js";

const PRODUCER = "rule_based_evidence_fact_frame_normalizer_v1";
const SOURCE_HASH = `sha256:${"a".repeat(64)}`;
const ALICE_PARIS = Object.freeze([
  Object.freeze({ role: "subject" as const, text: "Alice" }),
  Object.freeze({ role: "relation" as const, text: "lives" }),
  Object.freeze({ role: "value" as const, text: "Paris" })
]);
const BOB_BERLIN = Object.freeze([
  Object.freeze({ role: "subject" as const, text: "Bob" }),
  Object.freeze({ role: "relation" as const, text: "lives" }),
  Object.freeze({ role: "value" as const, text: "Berlin" })
]);
const SHANGHAI = Object.freeze([
  Object.freeze({ role: "subject" as const, text: "李" }),
  Object.freeze({ role: "relation" as const, text: "住在" }),
  Object.freeze({ role: "value" as const, text: "上海" })
]);
const BEIJING = Object.freeze([
  Object.freeze({ role: "subject" as const, text: "王" }),
  Object.freeze({ role: "relation" as const, text: "住在" }),
  Object.freeze({ role: "value" as const, text: "北京" })
]);

describe("capture proof typed fact-frame receipts", () => {
  it("preserves the verified formed capture plus evidence_id", () => {
    const alice = formed(PRODUCER, ALICE_PARIS);
    const candidate = memory("mem-1", ["ev-alice"]);
    const diagnostics = capture(candidate, { "ev-alice": alice });
    const row = rowOf(diagnostics, candidate);
    expect(row.typed_fact_frames).toEqual({
      status: "available",
      value: [{ capture: alice, evidence_id: "ev-alice" }]
    });
    expect(row.typed_fact_frames).not.toEqual({ status: "available", value: [] });
  });

  it("keeps a stored unavailable formation unavailable rather than receipt-absent", () => {
    const candidate = memory("mem-1", ["ev-missing"]);
    const diagnostics = capture(candidate, {
      "ev-missing": statusCapture("unavailable")
    });
    expect(rowOf(diagnostics, candidate).typed_fact_frames).toEqual({
      status: "unavailable",
      reason: "typed_fact_frame_formation_unavailable"
    });
    expect(copyTypedFactFrameReceiptsFromFormations(
      ["ev-absent"],
      {}
    )).toEqual({});
  });

  it("distinguishes formation ineligible and rejected from unavailable", () => {
    expect(rowOf(capture(memory("mem-1", ["ev-ineligible"]), {
      "ev-ineligible": statusCapture("ineligible")
    }), memory("mem-1", ["ev-ineligible"])).typed_fact_frames).toEqual({
      status: "unavailable",
      reason: "typed_fact_frame_formation_ineligible"
    });
    expect(rowOf(capture(memory("mem-1", ["ev-rejected"]), {
      "ev-rejected": statusCapture("rejected")
    }), memory("mem-1", ["ev-rejected"])).typed_fact_frames).toEqual({
      status: "unavailable",
      reason: "typed_fact_frame_formation_rejected"
    });
    expect(copyTypedFactFrameReceiptsFromFormations(
      ["ev-ineligible", "ev-rejected"],
      {
        "ev-ineligible": statusCapture("ineligible"),
        "ev-rejected": statusCapture("rejected")
      }
    )).toEqual({ gap: "typed_fact_frame_formation_unavailable" });
  });

  it("rejects a tampered capture digest at the copy boundary", () => {
    // A digest mismatch is corrupted proof, not an ordinary unavailable gap.
    // Converting it to unavailable would hide invalid evidence.
    const alice = formed(PRODUCER, ALICE_PARIS);
    const tampered = { ...alice, capture_digest: `sha256:${"0".repeat(64)}` };
    expect(() => copyTypedFactFrameReceiptsFromFormations(
      ["ev-alice"],
      { "ev-alice": tampered }
    )).toThrow(/evidence fact-frame formation capture digest mismatch/);
    expect(() => capture(memory("mem-1", ["ev-alice"]), { "ev-alice": tampered }))
      .toThrow(/evidence fact-frame formation capture digest mismatch/);
  });

  it("fail-closes a forged formed capture that omits its producer", () => {
    const forged = {
      schema_version: 1,
      operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
      status: "formed",
      producer_operator_id: null,
      source_hash: SOURCE_HASH,
      fact_frame: { schema_version: 1, slots: ALICE_PARIS },
      capture_digest: `sha256:${"0".repeat(64)}`
    } as EvidenceFactFrameFormationCapture;
    expect(() => copyTypedFactFrameReceiptsFromFormations(
      ["ev-alice"],
      { "ev-alice": forged }
    )).toThrow();
  });

  it("does not accept content-owned or whole-content value as a typed receipt", () => {
    const candidate = memory("mem-1", ["ev-alice"]);
    const diagnostics = capture(candidate, {
      "ev-alice": formed(CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID, [
        { role: "subject", text: "Alice" },
        { role: "relation", text: "lives" },
        { role: "value", text: "Alice lives in Paris" }
      ])
    });
    expect(rowOf(diagnostics, candidate).typed_fact_frames).toEqual({
      status: "unavailable",
      reason: "content_owned_excluded"
    });
    expect(JSON.stringify(diagnostics)).not.toContain("Alice lives in Paris");
  });

  it("denies a rule-based query fact-frame producer used as a candidate formation", () => {
    const queryCapture = formed(RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID, ALICE_PARIS);
    expect(copyTypedFactFrameReceiptsFromFormations(
      ["ev-query"],
      { "ev-query": queryCapture }
    )).toEqual({ gap: "typed_fact_frame_query_producer_denied" });
    const diagnostics = capture(memory("mem-1", ["ev-query"]), {
      "ev-query": queryCapture
    });
    expect(rowOf(diagnostics, memory("mem-1", ["ev-query"])).typed_fact_frames).toEqual({
      status: "unavailable",
      reason: "typed_fact_frame_query_producer_denied"
    });
    expect(JSON.stringify(diagnostics.candidate_proposition_provenance))
      .not.toContain("Alice");
  });

  it("does not collapse two distinct formed frames into a false conjunction", () => {
    const candidate = memory("mem-1", ["ev-alice", "ev-bob"]);
    const diagnostics = capture(candidate, {
      "ev-alice": formed(PRODUCER, ALICE_PARIS),
      "ev-bob": formed(PRODUCER, BOB_BERLIN)
    });
    const frames = rowOf(diagnostics, candidate).typed_fact_frames;
    expect(frames.status).toBe("available");
    if (frames.status !== "available") return;
    expect(frames.value).toHaveLength(2);
    expect(frames.value.map((frame) => frame.evidence_id)).toEqual([
      "ev-alice",
      "ev-bob"
    ]);
    expect(hasJoinedProposition(frames.value, "Alice", "lives", "Berlin")).toBe(false);
  });

  it("does not join a memory ref with a sibling capsule candidate", () => {
    const memoryCandidate = memory("mem-1", ["ev-alice"]);
    const capsuleCandidate = {
      entry: { object_id: "ev-bob", evidence_refs: [] },
      objectKind: "evidence_capsule" as const
    };
    const diagnostics = buildCaptureProofDiagnostics(
      { retrievalFieldBundle: { memoryLexicalBoundProofs: () => [] } },
      {
        supplementaryData: {
          factFrameFormationsByEvidenceId: {
            "ev-alice": formed(PRODUCER, ALICE_PARIS),
            "ev-bob": formed(PRODUCER, BOB_BERLIN)
          }
        }
      },
      [memoryCandidate, capsuleCandidate]
    );
    const memoryFrames = rowOf(diagnostics, memoryCandidate).typed_fact_frames;
    const capsuleFrames = rowOf(diagnostics, capsuleCandidate).typed_fact_frames;
    expect(memoryFrames.status).toBe("available");
    expect(capsuleFrames.status).toBe("available");
    if (memoryFrames.status !== "available" || capsuleFrames.status !== "available") return;
    expect(memoryFrames.value.map((frame) => frame.evidence_id)).toEqual(["ev-alice"]);
    expect(capsuleFrames.value.map((frame) => frame.evidence_id)).toEqual(["ev-bob"]);
    expect(hasJoinedProposition(memoryFrames.value, "Alice", "lives", "Berlin")).toBe(false);
    expect(hasJoinedProposition(capsuleFrames.value, "Alice", "lives", "Berlin")).toBe(false);
  });

  it("dedupes identical receipts across repeated refs in code-unit order", () => {
    const alice = formed(PRODUCER, ALICE_PARIS);
    const candidate = memory("mem-1", ["ev-alice", "ev-alice", "ev-alice"]);
    const diagnostics = capture(candidate, { "ev-alice": alice });
    const frames = rowOf(diagnostics, candidate).typed_fact_frames;
    expect(frames.status).toBe("available");
    if (frames.status !== "available") return;
    expect(frames.value).toEqual([{ capture: alice, evidence_id: "ev-alice" }]);
  });

  it("orders CJK evidence identities by code units, not locale collation", () => {
    const shanghai = formed(PRODUCER, SHANGHAI);
    const beijing = formed(PRODUCER, BEIJING);
    const copied = copyTypedFactFrameReceiptsFromFormations(
      ["ev-北京", "ev-上海"],
      { "ev-北京": beijing, "ev-上海": shanghai }
    );
    expect(copied.receipts?.map((receipt) => receipt.evidence_id)).toEqual([
      "ev-上海",
      "ev-北京"
    ]);
  });

  it("emits only formed receipts when a sibling formation is unavailable", () => {
    const alice = formed(PRODUCER, ALICE_PARIS);
    const candidate = memory("mem-1", ["ev-alice", "ev-missing"]);
    const diagnostics = capture(candidate, {
      "ev-alice": alice,
      "ev-missing": statusCapture("unavailable")
    });
    expect(rowOf(diagnostics, candidate).typed_fact_frames).toEqual({
      status: "available",
      value: [{ capture: alice, evidence_id: "ev-alice" }]
    });
  });

  it("omits fat typed-frame state when candidate evidence is not included", () => {
    const candidate = memory("mem-1", ["ev-alice"]);
    const captureProofDiagnostics = capture(candidate, {
      "ev-alice": formed(PRODUCER, ALICE_PARIS)
    });
    const omitted = buildRecallDiagnostics({
      ...diagnosticParams(captureProofDiagnostics),
      includeCandidateEvidence: false
    });
    expect(omitted).not.toHaveProperty("candidate_proposition_provenance");
    expect(JSON.stringify(omitted)).not.toContain(PRODUCER);
  });

  it("omits evidence fact-frame formations from selection receipts", () => {
    const candidates = [createRankedCandidate("candidate-1", 1, 0.9)];
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    selectCandidates({
      orderedCandidates: candidates,
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        factFrameFormationsByEvidenceId: Object.freeze({
          "ev-1": formed(PRODUCER, ALICE_PARIS)
        })
      }),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: rankMap(candidates),
      selectionBoundaryObserver: (pending) => {
        boundary = materializeFineAssessmentSelectionBoundary(pending);
        return undefined;
      }
    });
    if (boundary === undefined) throw new Error("selection boundary was not observed");
    expect(boundary.input.supplementary_data)
      .not.toHaveProperty("factFrameFormationsByEvidenceId");
  });
});

function capture(
  candidate: ReturnType<typeof memory>,
  formations: Readonly<Record<string, EvidenceFactFrameFormationCapture>>
) {
  return buildCaptureProofDiagnostics(
    { retrievalFieldBundle: { memoryLexicalBoundProofs: () => [] } },
    { supplementaryData: { factFrameFormationsByEvidenceId: formations } },
    [candidate]
  );
}

function memory(objectId: string, evidenceRefs: readonly string[]) {
  return { entry: { object_id: objectId, evidence_refs: evidenceRefs } };
}

function formed(
  producerOperatorId: string,
  slots: readonly Readonly<AssociativeFactSlot>[]
): EvidenceFactFrameFormationCapture {
  return digestCapture({
    schema_version: 1,
    operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
    status: "formed",
    producer_operator_id: producerOperatorId,
    source_hash: SOURCE_HASH,
    fact_frame: { schema_version: 1, slots }
  });
}

function statusCapture(
  status: "ineligible" | "rejected" | "unavailable"
): EvidenceFactFrameFormationCapture {
  return digestCapture({
    schema_version: 1,
    operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
    status,
    producer_operator_id: null,
    source_hash: SOURCE_HASH,
    fact_frame: null
  });
}

function digestCapture(
  body: Readonly<EvidenceFactFrameFormationCaptureBody>
): EvidenceFactFrameFormationCapture {
  return {
    ...body,
    capture_digest: `sha256:${createHash("sha256")
      .update(evidenceFactFrameFormationCapturePreimage(body), "utf8")
      .digest("hex")}`
  };
}

function rowOf(
  diagnostics: ReturnType<typeof buildCaptureProofDiagnostics>,
  candidate: ReturnType<typeof memory> | {
    readonly entry: { readonly object_id: string; readonly evidence_refs: readonly string[] };
    readonly objectKind?: "evidence_capsule";
  }
) {
  return diagnostics.candidate_proposition_provenance[
    buildRecallCandidateDedupeKey(candidate)
  ]!;
}

function hasJoinedProposition(
  frames: readonly Readonly<{
    readonly capture: Readonly<{
      readonly fact_frame: Readonly<{
        readonly slots: readonly Readonly<{ readonly role: string; readonly text: string }>[];
      }> | null;
    }>;
  }>[],
  subject: string,
  relation: string,
  value: string
): boolean {
  return frames.some((frame) => {
    const byRole = new Map(
      (frame.capture.fact_frame?.slots ?? []).map((slot) => [slot.role, slot.text])
    );
    return byRole.get("subject") === subject &&
      byRole.get("relation") === relation &&
      byRole.get("value") === value;
  });
}

function diagnosticParams(captureProofDiagnostics: CaptureProofDiagnostics) {
  return {
    queryProbes: Object.freeze({
      normalized_query: "where did alice live",
      object_ids: [],
      subject_hints: [],
      evidence_refs: [],
      run_ids: [],
      surface_ids: [],
      file_paths: [],
      command_names: [],
      package_names: [],
      task_refs: [],
      dimensions: [],
      scope_classes: [],
      domain_tags: [],
      lexical_terms: ["alice", "live"],
      expanded_terms: [],
      phrases: [],
      char_ngrams: [],
      date_terms: []
    }),
    captureProofDiagnostics,
    totalScanned: 0,
    candidatePoolCount: 0,
    preBudgetCount: 0,
    deliveredCount: 0,
    embeddingProviderStatus: "provider_not_requested" as const,
    embeddingSupplementStatus: "disabled" as const,
    providerDegradationReason: null,
    answerRerankDiagnostics: {
      status: "not_requested" as const,
      expected_count: 0,
      scored_count: 0,
      failure_class: null
    },
    graphExpansionDiagnostics: {
      graph_expansion_plane_count_per_hop: [0, 0] as const,
      graph_expansion_plane_count_per_edge_type: {
        derives_from: 0,
        recalls: 0,
        supports: 0
      }
    },
    candidates: [],
    fineAssessmentPrunedCandidates: [],
    tokenEconomy: {
      delivered_context_tokens_estimate: 0,
      coarse_pool_size: 0,
      fine_evaluated: 0,
      fine_pruned_count: 0,
      fine_priority_overflow_count: 0,
      fusion_families_with_hits: 0,
      embedding_inference_calls: 0
    }
  };
}
