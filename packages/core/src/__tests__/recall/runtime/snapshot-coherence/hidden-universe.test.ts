import { describe, expect, it } from "vitest";
import {
  SnapshotCoherenceContractError,
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  publicSnapshotCoherenceReceiptBytes
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import {
  HIDDEN_SCOPE,
  PRINCIPAL,
  declaration,
  exactVectorInput
} from "./fixtures.js";

describe("snapshot hidden universe non-interference", () => {
  it("leaves public receipt bytes unchanged for legal restricted deltas", () => {
    const vector = createSnapshotVectorV1(exactVectorInput());
    const first = createSnapshotCoherenceReceiptV1(vector, {
      restricted_universe: {
        sources: [declaration({
          source_owner: "hidden-store-a",
          principal: PRINCIPAL,
          authorized_scope: HIDDEN_SCOPE,
          generation: "hidden-a"
        })]
      }
    });
    const second = createSnapshotCoherenceReceiptV1(vector, {
      restricted_universe: {
        sources: [declaration({
          source_owner: "hidden-store-b",
          principal: PRINCIPAL,
          authorized_scope: HIDDEN_SCOPE,
          generation: "hidden-b",
          source_frontier: "hidden-frontier"
        })]
      }
    });
    expect(first.coherence_state).toBe("coherent_exact");
    expect(publicSnapshotCoherenceReceiptBytes(first)).toBe(
      publicSnapshotCoherenceReceiptBytes(second)
    );
    expect(first.vector_digest).toBe(second.vector_digest);
    expect(first.receipt_digest).toBe(second.receipt_digest);
    expect(publicSnapshotCoherenceReceiptBytes(first)).not.toContain("hidden-store-a");
    expect(publicSnapshotCoherenceReceiptBytes(first)).not.toContain("hidden-frontier");
  });

  it("rejects restricted sources that leak into authorized scope or owners", () => {
    const vector = createSnapshotVectorV1(exactVectorInput());
    expect(() => createSnapshotCoherenceReceiptV1(vector, {
      restricted_universe: {
        sources: [declaration({
          source_owner: "hidden-leak-scope",
          authorized_scope: "scope-authorized"
        })]
      }
    })).toThrow(SnapshotCoherenceContractError);
    expect(() => createSnapshotCoherenceReceiptV1(vector, {
      restricted_universe: {
        sources: [declaration({
          source_owner: "embedding_generation_and_model",
          authorized_scope: HIDDEN_SCOPE
        })]
      }
    })).toThrow(SnapshotCoherenceContractError);
  });
});
