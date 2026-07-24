import { describe, expect, it } from "vitest";
import {
  assertProviderTaskFailureIsolationScope,
  resolveProviderTaskFailureTolerance
} from "../../../longmemeval/extraction/fill/policy/provider-task-failure-isolation.js";

const DIGEST = "a".repeat(64);

describe("provider task failure isolation policy", () => {
  it("automatically isolates continuable failures for expansion fills", () => {
    expect(resolveProviderTaskFailureTolerance({
      requested: false,
      questionBatchLimit: undefined,
      receipt: targetBoundFillAuthority().receipt,
      expansion: true
    })).toBe(true);
  });

  it("keeps question-bounded expansion isolation forbidden", () => {
    expect(() => assertProviderTaskFailureIsolationScope({
      requested: true,
      questionBatchLimit: 1,
      authority: targetBoundFillAuthority()
    })).toThrow(/full-window.*question batch/u);
  });

  it("keeps unbound expansion isolation forbidden", () => {
    expect(() => assertProviderTaskFailureIsolationScope({
      requested: true,
      questionBatchLimit: undefined,
      authority: {
        receipt: targetBoundFillAuthority().receipt
      }
    })).toThrow(/target-selection-bound fill authority/u);
  });

  it("does not tolerate an expansion marker outside a fill receipt", () => {
    expect(resolveProviderTaskFailureTolerance({
      requested: false,
      questionBatchLimit: undefined,
      receipt: {
        ...targetBoundFillAuthority().receipt,
        action: "probe"
      },
      expansion: true
    })).toBe(false);
  });
});

function targetBoundFillAuthority() {
  return {
    receipt: {
      action: "fill" as const,
      target_selection_digest: DIGEST,
      probe_key: undefined,
      repair_scope: undefined,
      direct_spend: undefined
    },
    targetSelection: {
      receipt_digest: DIGEST
    }
  };
}
