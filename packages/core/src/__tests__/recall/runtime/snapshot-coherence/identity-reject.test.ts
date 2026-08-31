import { describe, expect, it } from "vitest";
import {
  SnapshotCoherenceContractError,
  createSnapshotVectorV1,
  verifySnapshotCoherenceReceiptV1,
  verifySnapshotVectorV1,
  createSnapshotCoherenceReceiptV1,
  type SnapshotVectorV1Input
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import { SHA_A, declaration, exactVectorInput, remainingEffect } from "./fixtures.js";

function expectCode(code: string, input: SnapshotVectorV1Input): void {
  expect(() => createSnapshotVectorV1(input)).toThrow(SnapshotCoherenceContractError);
  try {
    createSnapshotVectorV1(input);
  } catch (error) {
    expect(error).toBeInstanceOf(SnapshotCoherenceContractError);
    expect((error as SnapshotCoherenceContractError).code).toBe(code);
  }
}

describe("snapshot coherence identity rejects", () => {
  it("rejects malformed digest", () => {
    expectCode("malformed_digest", exactVectorInput({
      base_store_digest: "sha256:not-a-digest"
    }));
    expectCode("malformed_digest", exactVectorInput({
      decision_contract_digest: "sha256:00"
    }));
    const vector = createSnapshotVectorV1(exactVectorInput());
    expect(() => verifySnapshotVectorV1({
      ...vector,
      base_store_digest: SHA_A,
      vector_digest: SHA_A
    })).toThrow(SnapshotCoherenceContractError);
    const receipt = createSnapshotCoherenceReceiptV1(vector);
    expect(() => verifySnapshotCoherenceReceiptV1({
      ...receipt,
      receipt_digest: SHA_A
    }, vector)).toThrow(/malformed_digest|digest/u);
  });

  it("rejects duplicate source owner", () => {
    expectCode("duplicate_source_owner", exactVectorInput({
      retrieval_channel_snapshots: [
        declaration({ source_owner: "evidence_fts_exact" }),
        declaration({ source_owner: "evidence_fts_exact" })
      ]
    }));
    expectCode("duplicate_source_owner", exactVectorInput({
      retrieval_channel_snapshots: [
        declaration({ source_owner: "embedding_generation_and_model" })
      ]
    }));
  });

  it("rejects mismatched principal and authorized scope", () => {
    expectCode("mismatched_principal_scope", exactVectorInput({
      projection_generation: declaration({
        source_owner: "projection_generation",
        principal: "other-principal"
      })
    }));
    expectCode("mismatched_principal_scope", exactVectorInput({
      projection_generation: declaration({
        source_owner: "projection_generation",
        authorized_scope: "scope-foreign"
      })
    }));
  });

  it("rejects incompatible base frontier on exact or bounded sources", () => {
    expectCode("incompatible_base_frontier", exactVectorInput({
      transaction_frontier: ""
    }));
    expectCode("incompatible_base_frontier", exactVectorInput({
      transaction_frontier: " tx-frontier-1"
    }));
    expectCode("incompatible_base_frontier", exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        source_frontier: ""
      })
    }));
    expectCode("incompatible_base_frontier", exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        source_frontier: " other-tx",
        lag_bound: {
          kind: "bounded",
          remaining_effect: remainingEffect("embedding_generation_and_model", "lag-1")
        }
      })
    }));
  });

  it("rejects mixed operator or generation identity", () => {
    expectCode("mixed_operator_generation", exactVectorInput({
      formation_operator_versions: [["formation", "1"], ["formation", "2"]]
    }));
  });

  it("rejects non-instant times and untyped remaining-effect", () => {
    expectCode("malformed_time", exactVectorInput({
      effective_as_of: "not-a-time"
    }));
    expectCode("mixed_operator_generation", exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        lag_bound: {
          kind: "bounded",
          remaining_effect: "nonsense" as never
        }
      })
    }));
  });
});
