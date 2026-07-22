import { describe, expect, it } from "vitest";
import { assertImmediateContinuationAdoptionParent } from
  "../../../../longmemeval/extraction/authority/continuation/child-claim.js";

const parent = authority("1", "2", "3");
const child = authority("4", "5", "6", parent);
const parentSelection = selection("3");
const childSelection = selection("6", parent);

describe("explicit continuation adoption ancestry", () => {
  it("accepts only the actual predecessor's immediate parent edge", () => {
    expect(() => assertImmediateContinuationAdoptionParent({
      parent,
      parentTargetSelection: parentSelection,
      child,
      childTargetSelection: childSelection
    })).not.toThrow();
  });

  it.each([
    ["unrelated sibling", authority("7", "8", "9")],
    ["duplicate current node", child],
    ["distant ancestor", authority("a", "b", "c")]
  ])("rejects a %s instead of silently adopting multiple hops", (_label, candidate) => {
    expect(() => assertImmediateContinuationAdoptionParent({
      parent: candidate,
      parentTargetSelection: selection(candidate.target_selection_digest!),
      child,
      childTargetSelection: childSelection
    })).toThrow(/immediate parent/u);
  });
});

function authority(
  receiptSeed: string,
  lineageSeed: string,
  selectionSeed: string,
  predecessor?: ReturnType<typeof authority>
) {
  return {
    receipt_digest: receiptSeed.repeat(64),
    lineage_digest: lineageSeed.repeat(64),
    target_selection_digest: selectionSeed.repeat(64),
    ...(predecessor === undefined ? {} : {
      continuation: {
        predecessor: {
          receipt_digest: predecessor.receipt_digest,
          lineage_digest: predecessor.lineage_digest
        }
      }
    })
  };
}

function selection(seed: string, predecessor?: ReturnType<typeof authority>) {
  return {
    receipt_digest: seed.length === 1 ? seed.repeat(64) : seed,
    selection_basis: predecessor === undefined
      ? { kind: "retired_source_rebuild" as const, operator: "test" }
      : {
          kind: "same_root_continuation" as const,
          predecessor_target_selection_digest: predecessor.target_selection_digest!,
          predecessor_authority_receipt_digest: predecessor.receipt_digest
        }
  };
}
