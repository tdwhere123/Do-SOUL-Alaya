import { describe, expect, it } from "vitest";
import { GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID } from "@do-soul/alaya-soul";
import { binaryUseEvidenceSemanticGraph } from
  "../../../../../../packages/core/src/__tests__/recall/supplementary-data-test-fixtures.js";
import { EVIDENCE_ID } from "../../runtime/field/p217-planted-harness.js";
import {
  assertionSignal,
  collectLiveSupplement,
  createdEvidenceId,
  f3CaptureJob,
  f3Factors,
  openEligibilityRuntime,
  readDurableFormation,
  readQualifiedCapture,
  readQualifiedEvidence,
  withoutVerifiedAssertionHash
} from "./formation-eligibility-live-path-fixture.js";

const QUALIFIED_NEGATIVE_CASES = [
  { name: "graphless", payload: {}, status: "unavailable", seal: "unavailable" },
  {
    name: "unbound",
    payload: { semantic_factor_graph: unboundEvidenceGraph() },
    status: "rejected",
    seal: "rejected"
  },
  {
    name: "gold-only",
    payload: {
      gold_semantic_factor_graph: binaryUseEvidenceSemanticGraph(),
      gold_osf_ids: ["gold-atlas"]
    },
    status: "unavailable",
    seal: "unavailable"
  }
] as const;

describe("formation eligibility live producer to consumer path", () => {
  it.each(QUALIFIED_NEGATIVE_CASES)(
    "fail-closes $name through sqlite qualification and recall",
    async (testCase) => {
      const runtime = await openEligibilityRuntime();
      const received = await runtime.signalService.receiveSignal(
        assertionSignal(`signal-${testCase.name}`, testCase.payload)
      );
      expect(received.triage_result).toBe("accepted");
      expect(createdEvidenceId(received)).toBe(EVIDENCE_ID);
      const capture = await readQualifiedCapture(runtime.evidenceRepo, EVIDENCE_ID);
      expect(capture).toMatchObject({ status: testCase.status, graph: null });
      expect(capture).toHaveProperty("status", testCase.status);
      expect(hasGoldAuthorityKey(capture)).toBe(false);
      expect(f3Factors(runtime.field)).toEqual([]);
      expect(f3CaptureJob(
        runtime.field,
        GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID
      )).toBeNull();
      expect(JSON.stringify(capture)).not.toContain("gold-atlas");

      const supplement = await collectLiveSupplement(runtime.evidenceRepo, EVIDENCE_ID);
      expect(supplement.semanticFactorFormationsByEvidenceId![EVIDENCE_ID]).toEqual(capture);
      expect(supplement.openSemanticFactorCompatibilityTrace!).toMatchObject({
        incomparable_seal: testCase.seal,
        matchable_evidence_count: 0,
        entries: []
      });
    }
  );

  it("defers garden_compile rejected grounding when the verified hash cannot rebuild", async () => {
    const runtime = await openEligibilityRuntime();
    await expect(runtime.signalService.receiveSignal(
      assertionSignal("signal-grounding-rejected-hashed", {
        semantic_factor_graph: binaryUseEvidenceSemanticGraph(),
        source_grounding: {
          version: 1,
          status: "rejected",
          content_basis: "none",
          reasons: ["source_grounding_rejected"]
        }
      })
    )).rejects.toMatchObject({ subCode: "PORT_UNAVAILABLE" });
    expect(await readQualifiedEvidence(runtime.evidenceRepo, EVIDENCE_ID)).toEqual([]);
    expect(readDurableFormation(runtime.database, EVIDENCE_ID)).toBeUndefined();
  });

  it("keeps rejected grounding durable but fail-closed at qualification", async () => {
    const runtime = await openEligibilityRuntime();
    const received = await runtime.signalService.receiveSignal(
      withoutVerifiedAssertionHash(assertionSignal("signal-grounding-rejected", {
        semantic_factor_graph: binaryUseEvidenceSemanticGraph(),
        source_grounding: {
          version: 1,
          status: "rejected",
          content_basis: "none",
          reasons: ["source_grounding_rejected"]
        }
      }))
    );
    expect(received.triage_result).toBe("accepted");
    expect(createdEvidenceId(received)).toBe(EVIDENCE_ID);
    expect(await readQualifiedEvidence(runtime.evidenceRepo, EVIDENCE_ID)).toEqual([]);
    const capture = readDurableFormation(runtime.database, EVIDENCE_ID);
    expect(capture).toMatchObject({ status: "rejected", graph: null });
    expect(hasGoldAuthorityKey(capture)).toBe(false);
    expect(f3Factors(runtime.field)).toEqual([]);
    expect(f3CaptureJob(
      runtime.field,
      GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID
    )).toBeNull();

    const supplement = await collectLiveSupplement(runtime.evidenceRepo, EVIDENCE_ID);
    expect(supplement.semanticFactorFormationsByEvidenceId![EVIDENCE_ID]).toBeUndefined();
    expect(supplement.openSemanticFactorCompatibilityTrace!).toMatchObject({
      matchable_evidence_count: 0,
      entries: []
    });
    expect(supplement.openSemanticFactorCompatibilityTrace!.incomparable_seal)
      .not.toBe("rejected");
  });

  it("keeps a source-bound formed graph matchable on the same live path", async () => {
    const runtime = await openEligibilityRuntime();
    const received = await runtime.signalService.receiveSignal(
      assertionSignal("signal-formed", {
        semantic_factor_graph: binaryUseEvidenceSemanticGraph()
      })
    );
    expect(createdEvidenceId(received)).toBe(EVIDENCE_ID);
    const capture = await readQualifiedCapture(runtime.evidenceRepo, EVIDENCE_ID);
    expect(capture).toMatchObject({
      status: "formed",
      producer_operator_id: GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID,
      graph: { source_kind: "evidence" }
    });
    expect(capture?.graph).not.toBeNull();
    expect(hasGoldAuthorityKey(capture)).toBe(false);
    expect(f3Factors(runtime.field)).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "f3", canonical_payload: "atlas" }),
      expect.objectContaining({ family: "f3", canonical_payload: "use" })
    ]));
    expect(f3CaptureJob(
      runtime.field,
      GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID
    )).toMatchObject({
      status: "succeeded",
      operator_id: GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID
    });

    const supplement = await collectLiveSupplement(runtime.evidenceRepo, EVIDENCE_ID);
    expect(supplement.semanticFactorFormationsByEvidenceId![EVIDENCE_ID]).toEqual(capture);
    expect(supplement.openSemanticFactorCompatibilityTrace!).toMatchObject({
      incomparable_seal: "none",
      matchable_evidence_count: 1,
      entries: [{ evidence_id: EVIDENCE_ID, receipt: { status: "compatible" } }]
    });
  });
});

function hasGoldAuthorityKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasGoldAuthorityKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, child]) =>
    isGoldAuthorityFieldKey(key) || hasGoldAuthorityKey(child));
}

function isGoldAuthorityFieldKey(key: string): boolean {
  return !key.startsWith("golden") && (
    key.startsWith("gold_") ||
    key.startsWith("gold-") ||
    /^gold[A-Z]/u.test(key)
  );
}

function unboundEvidenceGraph() {
  const graph = binaryUseEvidenceSemanticGraph();
  return {
    ...graph,
    factors: [
      ...graph.factors,
      { factor_id: "unused", surface: "Atlas", semantic_identity: "atlas" }
    ]
  };
}
