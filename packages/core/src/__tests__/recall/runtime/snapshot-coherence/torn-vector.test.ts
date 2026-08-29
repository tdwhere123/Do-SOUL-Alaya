import { describe, expect, it } from "vitest";
import {
  SnapshotCoherenceContractError,
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  createSourceFrontierDeclaration
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import { AS_OF, declaration, exactVectorInput, remainingEffect } from "./fixtures.js";

describe("snapshot torn vectors", () => {
  it("marks new FTS + stale embedding exact peers incoherent", () => {
    const receipt = createSnapshotCoherenceReceiptV1(createSnapshotVectorV1(exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        source_frontier: "tx-frontier-stale"
      })
    })));
    expect(receipt.coherence_state).toBe("incoherent");
    expect(receipt.reasons).toContain("torn_fts_embedding");
  });

  it("keeps FTS/embedding coherent_bounded when the stale side declares lag", () => {
    const receipt = createSnapshotCoherenceReceiptV1(createSnapshotVectorV1(exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
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
      projection_generation: declaration({
        source_owner: "projection_generation",
        source_frontier: "tx-frontier-stale"
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

  it("orders mixed-precision instants by time, not string", () => {
    expect(() => createSourceFrontierDeclaration(declaration({
      source_owner: "evidence_fts_exact",
      valid_time_domain: {
        kind: "bounded",
        from: "2026-01-01T00:00:00.500Z",
        to: "2026-01-01T00:00:00Z"
      }
    }))).toThrow(SnapshotCoherenceContractError);
    const accepted = createSourceFrontierDeclaration(declaration({
      source_owner: "evidence_fts_exact",
      valid_time_domain: {
        kind: "bounded",
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-01T00:00:00.500Z"
      }
    }));
    expect(accepted.valid_time_domain).toEqual({
      kind: "bounded",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-01T00:00:00.500Z"
    });
    const receipt = createSnapshotCoherenceReceiptV1(createSnapshotVectorV1(exactVectorInput({
      temporal_index_generation: declaration({
        source_owner: "temporal_index_generation",
        valid_time_domain: {
          kind: "bounded",
          from: "2026-01-01T00:00:00Z",
          to: "2026-08-01T00:00:00Z"
        }
      })
    })));
    expect(receipt.coherence_state).toBe("incoherent");
    expect(receipt.reasons).toContain("valid_time_transaction_time_mismatch");
  });

  it("treats independent generation ids as coherent_exact when source_frontiers match", () => {
    const receipt = createSnapshotCoherenceReceiptV1(createSnapshotVectorV1(exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        generation: "gen-embed-independent"
      }),
      retrieval_channel_snapshots: [
        declaration({
          source_owner: "evidence_fts_exact",
          generation: "gen-fts-independent"
        })
      ],
      governance_frontier: declaration({
        source_owner: "governance_frontier",
        generation: "gen-gov-independent"
      }),
      projection_generation: declaration({
        source_owner: "projection_generation",
        generation: "gen-proj-independent"
      })
    })));
    expect(receipt.coherence_state).toBe("coherent_exact");
    expect(receipt.reasons).not.toContain("torn_fts_embedding");
    expect(receipt.reasons).not.toContain("torn_governance_projection");
  });
});
