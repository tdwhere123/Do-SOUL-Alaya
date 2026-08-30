import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalSelectionReceiptPreimage,
  createCanonicalSelectionReceipt,
  verifyCanonicalSelectionReceipt,
  type CanonicalSelectionReceipt,
  type CanonicalSelectionReceiptBody
} from "@do-soul/alaya-protocol";
import { fineAssess } from "../../../recall/delivery/fine-assessment.js";
import { compileRecallQueryProbes } from "../../../recall/query/recall-query-probes.js";
import { buildDefaultPolicy } from "../../../recall/runtime/orchestration.js";
import type {
  CoarseRecallCandidate,
  RecallSupplementaryData
} from "../../../recall/runtime/recall-service-types.js";
import * as frontierPeel from "../../../recall/decision/query-proof/frontier-peel.js";
import * as liveObservations from "../../../recall/integration/shadow/live-observations.js";
import {
  isFailClosedShadowTrace,
  type ShadowCapturedTrace
} from "../../../recall/integration/shadow/integrate.js";
import { FIELD_PINS } from "../fine-assessment-selection-fixtures.js";
import { withFineDeliveryPath } from "../recall-service-test-fixtures.js";
import { assertCanonicalSelectionReceipt } from
  "../../../recall/delivery/canonical-receipt-validation.js";
import { fieldCandidates } from "./canonical-delivery-fixtures.js";
import { embeddingObserved, field, temporalObserved, view } from "../decision/query-proof/psi-test-support.js";

const NOW = "2026-07-12T00:00:00.000Z";
const IDS = ["cand-a", "cand-b", "cand-c"] as const;

describe("same-result observation and receipt reuse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the already-built observation field and frontiers on the hashed receipt", () => {
    const planted = plantedField();
    const result = fineAssess({
      ...assessParams(fieldCandidates(IDS)),
      shadowObservationField: planted
    });
    const trace = asCaptured(result.shadowTrace);
    const receipt = requireReceipt(result.capture_receipt);

    expect(receipt.observations_by_candidate_key).toBe(planted);
    expect(receipt.observations_by_candidate_key).toBe(trace.observations_by_candidate_key);
    expect(receipt.frontiers).toBe(trace.frontiers);
    expect(receipt.gamma.decisions).toBe(trace.decisions);
    expect(receipt.gamma.rejects).toBe(trace.walk_rejects);
    expect(receipt.gamma.set_utilities).toBe(trace.set_utilities);
    expect(result.candidates.map((candidate) => keyOf(candidate.object_id)))
      .toEqual(trace.prefix_proposal);
  });

  it("hashes observations_by_candidate_key with the same digest as the protocol oracle", () => {
    const result = fineAssess(assessParams(fieldCandidates(IDS)));
    const receipt = requireReceipt(result.capture_receipt);
    const body = receiptBody(receipt);
    const oracle = createCanonicalSelectionReceipt(body, sha256);
    const omitted = canonicalSelectionReceiptPreimage({
      ...body,
      observations_by_candidate_key: {}
    });

    expect(verifyCanonicalSelectionReceipt(receipt, sha256).receipt_digest)
      .toBe(receipt.receipt_digest);
    expect(receipt.receipt_digest).toBe(oracle.receipt_digest);
    expect(canonicalSelectionReceiptPreimage(body)).toContain("observations_by_candidate_key");
    expect(canonicalSelectionReceiptPreimage(body)).not.toBe(omitted);
    expect(Object.keys(body.observations_by_candidate_key ?? {}).sort())
      .toEqual([...body.field_membership.e1_keys].sort());
  });

  it("validates full receipt shape and closure without replacing live structures", () => {
    const receipt = requireReceipt(fineAssess(assessParams(fieldCandidates(IDS))).capture_receipt);
    const observations = receipt.observations_by_candidate_key;
    const frontiers = receipt.frontiers;
    const digest = receipt.receipt_digest;

    expect(assertCanonicalSelectionReceipt(receipt)).toBe(receipt);
    expect(receipt.observations_by_candidate_key).toBe(observations);
    expect(receipt.frontiers).toBe(frontiers);
    expect(receipt.receipt_digest).toBe(digest);
    expect(() => assertCanonicalSelectionReceipt({
      ...receipt,
      ranking_authority: "shape-invalid-but-closed"
    } as CanonicalSelectionReceipt)).toThrow();
  });

  it("builds the live field once and peels frontiers once", () => {
    const observe = vi.spyOn(liveObservations, "buildLiveObservationField");
    const peel = vi.spyOn(frontierPeel, "peelUndominated");
    const result = fineAssess(assessParams(fieldCandidates(IDS)));
    const receipt = requireReceipt(result.capture_receipt);

    expect(observe).toHaveBeenCalledTimes(1);
    expect(peel).toHaveBeenCalledTimes(1);
    expect(receipt.observations_by_candidate_key)
      .toBe(asCaptured(result.shadowTrace).observations_by_candidate_key);
    expect(receipt.frontiers).toBe(asCaptured(result.shadowTrace).frontiers);
  });
});

function receiptBody(receipt: CanonicalSelectionReceipt): CanonicalSelectionReceiptBody {
  const { receipt_digest: _digest, ...body } = receipt;
  return body;
}

function requireReceipt(
  receipt: CanonicalSelectionReceipt | undefined
): CanonicalSelectionReceipt {
  expect(receipt).toBeDefined();
  if (receipt === undefined) throw new Error("expected capture receipt");
  return receipt;
}

function asCaptured(trace: ReturnType<typeof fineAssess>["shadowTrace"]): ShadowCapturedTrace {
  expect(trace).toBeDefined();
  expect(isFailClosedShadowTrace(trace!)).toBe(false);
  if (trace === undefined || isFailClosedShadowTrace(trace)) {
    throw new Error("expected captured shadow trace");
  }
  return trace;
}

function plantedField() {
  return field({
    [keyOf("cand-a")]: view({
      temporal: temporalObserved(0.9),
      embedding: embeddingObserved(0.8)
    }),
    [keyOf("cand-b")]: view({
      temporal: temporalObserved(0.6),
      embedding: embeddingObserved(0.7)
    }),
    [keyOf("cand-c")]: view({
      temporal: temporalObserved(0.3),
      embedding: embeddingObserved(0.2)
    })
  });
}

function keyOf(objectId: string): string {
  return `workspace_local:memory_entry:${objectId}`;
}

function assessParams(candidates: readonly CoarseRecallCandidate[]) {
  return {
    ...FIELD_PINS,
    candidates,
    policy: withFineDeliveryPath(policy(), "canonical"),
    winnerMemoryIds: new Set<string>(),
    supplementaryData: supplementary(candidates),
    tokenEstimator: { estimate: () => 4 },
    now: () => NOW,
    warn: vi.fn()
  };
}

function policy() {
  return buildDefaultPolicy({
    strategy: "build",
    taskSurfaceRef: "task-surface-1",
    now: () => NOW,
    generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
  });
}

function supplementary(
  candidates: readonly CoarseRecallCandidate[]
): RecallSupplementaryData {
  const ftsRanks: Record<string, number> = {};
  const embeddingSimilarityScores: Record<string, number> = {};
  for (const [index, candidate] of candidates.entries()) {
    ftsRanks[candidate.entry.object_id] = Math.max(0, 1 - index * 0.07);
    embeddingSimilarityScores[candidate.entry.object_id] = 0.2 + index * 0.1;
  }
  return {
    queryProbes: compileRecallQueryProbes("where does the operator work on 2026-03-19?"),
    ftsRanks,
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    evidenceProjectionMatchesByRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores,
    evidenceSemanticActivationsByCandidateKey: new Map(),
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}

function sha256(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}
