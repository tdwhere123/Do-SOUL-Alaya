import type { RecallCandidate } from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  applySelectGammaSynthesis,
  type SelectGammaSynthesisPort
} from "../../../recall/delivery/select-gamma/synthesis-adapter.js";

const SELECTED = Object.freeze([
  Object.freeze({ object_id: "alpha" }) as Readonly<RecallCandidate>,
  Object.freeze({ object_id: "beta" }) as Readonly<RecallCandidate>
]);

describe("Select_Gamma synthesis adapter", () => {
  it("reports absence without changing selected membership", async () => {
    const result = await applySelectGammaSynthesis(input());

    expect(ids(result.selected_evidence)).toEqual(["alpha", "beta"]);
    expect(result.synthesis).toEqual({ status: "absent" });
  });

  it("runs one shot over selected evidence and ignores attempted membership output", async () => {
    const synthesize = vi.fn(async () => ({
      text: "one-shot summary",
      selected_candidate_keys: ["injected"]
    }));
    const result = await applySelectGammaSynthesis(input({ synthesize }));

    expect(synthesize).toHaveBeenCalledOnce();
    expect(ids(synthesize.mock.calls[0]![0].selected_evidence)).toEqual([
      "alpha", "beta"
    ]);
    expect(ids(result.selected_evidence)).toEqual(["alpha", "beta"]);
    expect(result.synthesis).toEqual({ status: "ok", text: "one-shot summary" });
  });

  it("keeps membership with malformed output", async () => {
    const result = await applySelectGammaSynthesis(input({
      synthesize: async () => ({ text: "   " })
    }));

    expect(ids(result.selected_evidence)).toEqual(["alpha", "beta"]);
    expect(result.synthesis).toEqual({
      status: "malformed",
      failure: "synthesis output text must be non-empty"
    });
  });

  it("keeps membership with truncated output", async () => {
    const result = await applySelectGammaSynthesis(input({
      synthesize: async () => ({ text: "cut off", truncated: true })
    }));

    expect(ids(result.selected_evidence)).toEqual(["alpha", "beta"]);
    expect(result.synthesis).toEqual({
      status: "truncated",
      failure: "synthesis output truncated",
      text: "cut off"
    });
  });

  it("keeps membership and distinguishes a thrown failure", async () => {
    const result = await applySelectGammaSynthesis(input({
      synthesize: async () => {
        throw new Error("provider unavailable");
      }
    }));

    expect(ids(result.selected_evidence)).toEqual(["alpha", "beta"]);
    expect(result.synthesis).toEqual({
      status: "failed",
      failure: "provider unavailable"
    });
  });
});

function input(port?: SelectGammaSynthesisPort) {
  return {
    workspace_id: "workspace-1",
    run_id: "run-1",
    query_text: "What matters?",
    selected_evidence: SELECTED,
    ...(port === undefined ? {} : { port })
  } as const;
}

function ids(candidates: readonly Readonly<RecallCandidate>[]): string[] {
  return candidates.map(({ object_id }) => object_id);
}
