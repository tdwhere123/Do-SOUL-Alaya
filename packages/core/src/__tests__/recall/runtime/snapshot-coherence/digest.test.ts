import { describe, expect, it } from "vitest";
import {
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  digestSnapshotCoherenceReceiptV1,
  digestSnapshotVectorV1
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import {
  declaration,
  exactVectorInput,
  reservedDeclarations
} from "./fixtures.js";

describe("snapshot coherence digest", () => {
  it("is stable for identical input and owner-order permutation", () => {
    const first = createSnapshotVectorV1(exactVectorInput());
    const second = createSnapshotVectorV1(exactVectorInput());
    const permuted = createSnapshotVectorV1(exactVectorInput({
      retrieval_channel_snapshots: [
        declaration({ source_owner: "evidence_fts_trigram" }),
        declaration({ source_owner: "evidence_fts_exact" })
      ]
    }));
    const originalOrder = createSnapshotVectorV1(exactVectorInput({
      retrieval_channel_snapshots: [
        declaration({ source_owner: "evidence_fts_exact" }),
        declaration({ source_owner: "evidence_fts_trigram" })
      ]
    }));

    expect(digestSnapshotVectorV1(first)).toBe(digestSnapshotVectorV1(second));
    expect(digestSnapshotVectorV1(permuted)).toBe(digestSnapshotVectorV1(originalOrder));
    const receipt = createSnapshotCoherenceReceiptV1(first);
    expect(receipt.coherence_state).toBe("coherent_exact");
    expect(digestSnapshotCoherenceReceiptV1(receipt)).toBe(receipt.receipt_digest);
    expect(receipt.vector_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("keeps vector_digest stable on incoherent torn input", () => {
    const torn = exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        generation: "gen-stale"
      })
    });
    const left = createSnapshotVectorV1(torn);
    const right = createSnapshotVectorV1(torn);
    expect(createSnapshotCoherenceReceiptV1(left).coherence_state).toBe("incoherent");
    expect(digestSnapshotVectorV1(left)).toBe(digestSnapshotVectorV1(right));
    expect(createSnapshotCoherenceReceiptV1(left).coherence_state).toBe("incoherent");
    expect(createSnapshotCoherenceReceiptV1(left).vector_digest).toBe(left.vector_digest);
  });

  it("changes receipt_digest when authorized generation changes", () => {
    const exact = createSnapshotCoherenceReceiptV1(
      createSnapshotVectorV1(exactVectorInput())
    );
    const reserved = reservedDeclarations();
    const changed = createSnapshotCoherenceReceiptV1(createSnapshotVectorV1(exactVectorInput({
      path_graph_generation: {
        ...reserved.path_graph_generation,
        generation: "gen-other"
      }
    })));
    expect(changed.vector_digest).not.toBe(exact.vector_digest);
    expect(changed.receipt_digest).not.toBe(exact.receipt_digest);
  });
});
