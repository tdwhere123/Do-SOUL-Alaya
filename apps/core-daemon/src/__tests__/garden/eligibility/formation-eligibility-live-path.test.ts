import { describe, expect, it } from "vitest";
import { binaryUseEvidenceSemanticGraph } from
  "../../../../../../packages/core/src/__tests__/memory/evidence-create/semantic-graph-fixture.js";
import { EVIDENCE_ID, MEMORY_ID } from "../../runtime/field/source-field-harness.js";
import {
  assertionSignal,
  recallLiveSource,
  createdEvidenceId,
  openEligibilityRuntime,
  readQualifiedEvidence,
  withoutVerifiedAssertionHash
} from "./formation-eligibility-live-path-fixture.js";

describe("source grounding through Garden materialization", () => {
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
    const index = await recallLiveSource(runtime, EVIDENCE_ID);
    expect(index.entries.find((entry) => entry.object_id === MEMORY_ID)?.claim).toBe("unknown");
  });
});
