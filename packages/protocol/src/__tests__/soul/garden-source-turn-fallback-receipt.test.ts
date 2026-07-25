import { describe, expect, it } from "vitest";
import {
  buildGardenSourceTurnFallbackReceiptPreimage,
  formatGardenSourceTurnFallbackArtifactRef,
  formatGardenSourceTurnFallbackSourceHash,
  hasGardenSourceTurnFallbackReceiptFormat,
  readGardenSourceTurnFallbackArtifactSignalId,
  readGardenSourceTurnFallbackReceipt,
  readGardenSourceTurnFallbackSourceHashDigest,
  verifyGardenSourceTurnFallbackReceipt
} from "../../index.js";
import { CandidateMemorySignalSchema } from "../../signals/candidate-memory-signal.js";

const DIGEST = "a".repeat(64);

describe("Garden source-turn fallback receipt", () => {
  it("round-trips the shared artifact and source-hash format", () => {
    const artifactRef = formatGardenSourceTurnFallbackArtifactRef("signal-1");
    const sourceHash = formatGardenSourceTurnFallbackSourceHash(DIGEST);

    expect(readGardenSourceTurnFallbackArtifactSignalId(artifactRef)).toBe("signal-1");
    expect(readGardenSourceTurnFallbackSourceHashDigest(sourceHash)).toBe(DIGEST);
    expect(hasGardenSourceTurnFallbackReceiptFormat({
      artifact_ref: artifactRef,
      source_hash: sourceHash
    })).toBe(true);
    expect(hasGardenSourceTurnFallbackReceiptFormat({
      artifact_ref: "alaya:garden-turn-evidence:",
      source_hash: sourceHash
    })).toBe(false);
  });

  it("parses a strict fallback envelope into one canonical preimage", () => {
    const signal = createSignal();
    const receipt = readGardenSourceTurnFallbackReceipt(signal);

    expect(receipt).toMatchObject({
      source_corpus: "Assistant: exact prior answer",
      reason: "empty_extraction",
      truncated: false,
      chars_clipped: 0,
      digest: DIGEST
    });
    expect(receipt?.preimage).toBe(
      buildGardenSourceTurnFallbackReceiptPreimage(receipt!)
    );
    expect(verifyGardenSourceTurnFallbackReceipt(signal, () => DIGEST))
      .toEqual(receipt);
    expect(verifyGardenSourceTurnFallbackReceipt(signal, () => "b".repeat(64)))
      .toBeNull();
  });

  it("rejects an envelope with extra authority or relation fields", () => {
    const signal = createSignal();

    expect(readGardenSourceTurnFallbackReceipt({
      ...signal,
      evidence_refs: ["claim-1"]
    })).toBeNull();
    expect(readGardenSourceTurnFallbackReceipt({
      ...signal,
      raw_payload: {
        ...signal.raw_payload,
        source_assertion: "invented"
      }
    })).toBeNull();
  });
});

function createSignal() {
  return CandidateMemorySignalSchema.parse({
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_evidence_anchor",
    signal_state: "materialized",
    object_kind: "source_turn",
    scope_hint: null,
    domain_tags: ["source-turn"],
    confidence: 1,
    evidence_refs: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      full_turn_content: "Assistant: exact prior answer",
      evidence_preservation: {
        version: 1,
        reason: "empty_extraction",
        truncated: false,
        chars_clipped: 0,
        source_receipt_sha256: DIGEST
      }
    },
    source_observation: null,
    created_at: "2026-07-25T00:00:00.000Z"
  });
}
