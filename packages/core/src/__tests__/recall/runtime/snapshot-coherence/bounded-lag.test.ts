import { describe, expect, it } from "vitest";
import {
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  publicSnapshotCoherenceReceiptBytes
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import { declaration, exactVectorInput } from "./fixtures.js";

describe("snapshot coherent_bounded lag", () => {
  it("preserves declared lag and never upgrades to exact", () => {
    const vector = createSnapshotVectorV1(exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        lag_bound: { kind: "bounded", remaining_effect: "embed-lag-1" }
      })
    }));
    const receipt = createSnapshotCoherenceReceiptV1(vector);
    expect(receipt.coherence_state).toBe("coherent_bounded");
    expect(receipt.reasons).toContain("declared_lag");
    expect(receipt.lag_bounds).toEqual(["embed-lag-1"]);
    expect(publicSnapshotCoherenceReceiptBytes(receipt)).toContain("embed-lag-1");
    expect(receipt.coherence_state).not.toBe("coherent_exact");
  });

  it("keeps bounded remaining-effect on the receipt digest input", () => {
    const bounded = createSnapshotCoherenceReceiptV1(createSnapshotVectorV1(exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        lag_bound: { kind: "bounded", remaining_effect: "embed-lag-1" }
      })
    })));
    const otherBound = createSnapshotCoherenceReceiptV1(createSnapshotVectorV1(exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        lag_bound: { kind: "bounded", remaining_effect: "embed-lag-2" }
      })
    })));
    expect(otherBound.receipt_digest).not.toBe(bounded.receipt_digest);
    expect(otherBound.coherence_state).toBe("coherent_bounded");
  });

  it("marks unavailable instead of coercing missing sources to exact", () => {
    const receipt = createSnapshotCoherenceReceiptV1(createSnapshotVectorV1(exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        lag_bound: { kind: "unavailable" },
        source_frontier: "missing-frontier"
      })
    })));
    expect(receipt.coherence_state).toBe("unavailable");
    expect(receipt.reasons).toContain("source_unavailable");
    expect(receipt.coherence_state).not.toBe("coherent_exact");
  });
});
