import { describe, expect, it } from "vitest";
import {
  SnapshotCoherenceContractError,
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  digestSnapshotCoherenceReceiptV1,
  verifySnapshotCoherenceReceiptV1,
  verifySnapshotVectorV1,
  type SnapshotCoherenceReceiptV1,
  type SnapshotVectorV1
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import { SHA_A, declaration, exactVectorInput, remainingEffect } from "./fixtures.js";

describe("snapshot coherence receipt verify", () => {
  it("accepts a freshly constructed exact receipt and vector", () => {
    const vector = createSnapshotVectorV1(exactVectorInput());
    const receipt = createSnapshotCoherenceReceiptV1(vector);
    expect(receipt.coherence_state).toBe("coherent_exact");
    expect(() => verifySnapshotCoherenceReceiptV1(receipt, vector)).not.toThrow();
  });

  it("rejects principal mismatch with a self-consistent receipt", () => {
    const { receipt, vector } = exactPair();
    expectMalformed(resign(receipt, { principal: "principal-other" }), vector);
  });

  it("rejects effective_as_of mismatch with a self-consistent receipt", () => {
    const { receipt, vector } = exactPair();
    expectMalformed(resign(receipt, { effective_as_of: "2020-01-01T00:00:00.000Z" }), vector);
  });

  it("rejects authorized_scopes mismatch with a self-consistent receipt", () => {
    const { receipt, vector } = exactPair();
    expectMalformed(resign(receipt, { authorized_scopes: ["scope-other"] }), vector);
  });

  it("rejects vector_digest mismatch with a self-consistent receipt", () => {
    const { receipt, vector } = exactPair();
    expectMalformed(resign(receipt, { vector_digest: SHA_A }), vector);
  });

  it("rejects coherence_state tamper after copy without resigning", () => {
    const { receipt, vector } = exactPair();
    expectMalformed({ ...receipt, coherence_state: "unavailable" }, vector);
  });

  it("rejects coherence_state mismatch with a self-consistent receipt", () => {
    const { receipt, vector } = exactPair();
    expectMalformed(resign(receipt, { coherence_state: "unavailable" }), vector);
  });

  it("rejects typed lag_bounds mismatch with a self-consistent receipt", () => {
    const vector = createSnapshotVectorV1(exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        lag_bound: {
          kind: "bounded",
          remaining_effect: remainingEffect("embedding_generation_and_model", "embed-lag-1")
        }
      })
    }));
    const receipt = createSnapshotCoherenceReceiptV1(vector);
    expectMalformed(resign(receipt, {
      lag_bounds: [remainingEffect("embedding_generation_and_model", "embed-lag-2")]
    }), vector);
  });

  it("rejects a stale vector_digest after a non-classifying vector mutation", () => {
    const { receipt, vector } = exactPair();
    const mutated: SnapshotVectorV1 = {
      ...vector,
      path_graph_generation: {
        ...vector.path_graph_generation,
        operator_or_model_version: "op-stale"
      }
    };
    const resigned = resign(receipt, { vector_digest: mutated.vector_digest });
    expectMalformedDigest(() => verifySnapshotVectorV1(mutated));
    expectMalformed(resigned, mutated);
  });
});

function exactPair(): Readonly<{
  readonly receipt: SnapshotCoherenceReceiptV1;
  readonly vector: SnapshotVectorV1;
}> {
  const vector = createSnapshotVectorV1(exactVectorInput());
  return { vector, receipt: createSnapshotCoherenceReceiptV1(vector) };
}

function resign(
  receipt: SnapshotCoherenceReceiptV1,
  patch: Partial<SnapshotCoherenceReceiptV1>
): SnapshotCoherenceReceiptV1 {
  const next = { ...receipt, ...patch };
  return { ...next, receipt_digest: digestSnapshotCoherenceReceiptV1(next) };
}

function expectMalformed(
  receipt: SnapshotCoherenceReceiptV1,
  vector: SnapshotVectorV1
): void {
  expectMalformedDigest(() => verifySnapshotCoherenceReceiptV1(receipt, vector));
}

function expectMalformedDigest(run: () => void): void {
  expect(run).toThrow(SnapshotCoherenceContractError);
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SnapshotCoherenceContractError);
    expect((error as SnapshotCoherenceContractError).code).toBe("malformed_digest");
  }
}
