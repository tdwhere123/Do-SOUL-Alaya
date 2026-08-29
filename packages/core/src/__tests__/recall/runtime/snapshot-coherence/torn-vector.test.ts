import { describe, expect, it } from "vitest";
import {
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import { AS_OF, declaration, exactVectorInput, remainingEffect } from "./fixtures.js";

describe("snapshot torn vectors", () => {
  it("marks new FTS + stale embedding exact peers incoherent", () => {
    const receipt = createSnapshotCoherenceReceiptV1(createSnapshotVectorV1(exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        generation: "gen-stale"
      })
    })));
    expect(receipt.coherence_state).toBe("incoherent");
    expect(receipt.reasons).toContain("torn_fts_embedding");
  });

  it("keeps FTS/embedding coherent_bounded when the stale side declares lag", () => {
    const receipt = createSnapshotCoherenceReceiptV1(createSnapshotVectorV1(exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        generation: "gen-stale",
        lag_bound: {
          kind: "bounded",
          remaining_effect: remainingEffect("embedding_generation_and_model", "embed-stale")
        }
      })
    })));
    expect(receipt.coherence_state).toBe("coherent_bounded");
    expect(receipt.lag_bounds).toEqual([
      remainingEffect("embedding_generation_and_model", "embed-stale")
    ]);
    expect(receipt.coherence_state).not.toBe("incoherent");
  });

  it("marks new governance + stale projection exact peers incoherent", () => {
    const receipt = createSnapshotCoherenceReceiptV1(createSnapshotVectorV1(exactVectorInput({
      governance_frontier: declaration({
        source_owner: "governance_frontier",
        generation: "gen-gov-new"
      })
    })));
    expect(receipt.coherence_state).toBe("incoherent");
    expect(receipt.reasons).toContain("torn_governance_projection");
  });

  it("marks valid-time excluding as_of incoherent for exact sources", () => {
    const receipt = createSnapshotCoherenceReceiptV1(createSnapshotVectorV1(exactVectorInput({
      temporal_index_generation: declaration({
        source_owner: "temporal_index_generation",
        valid_time_domain: {
          kind: "bounded",
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-06-01T00:00:00.000Z"
        }
      })
    })));
    expect(receipt.coherence_state).toBe("incoherent");
    expect(receipt.reasons).toContain("valid_time_transaction_time_mismatch");
    expect(AS_OF >= "2026-06-01T00:00:00.000Z").toBe(true);
  });
});
