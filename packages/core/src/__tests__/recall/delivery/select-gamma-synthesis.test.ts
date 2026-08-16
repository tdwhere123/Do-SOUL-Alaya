import { describe, expect, it } from "vitest";
import { applySelectGammaSynthesis } from
  "../../../recall/delivery/select-gamma/synthesis-adapter.js";

const SELECTED = Object.freeze(["alpha", "beta", "gamma"]);

describe("Select_Gamma synthesis adapter", () => {
  it("returns selected evidence unchanged when synthesis is absent", () => {
    const result = applySelectGammaSynthesis({
      selected_candidate_keys: SELECTED
    });
    expect(result.selected_candidate_keys).toEqual(SELECTED);
    expect(result.synthesis).toEqual({ status: "absent" });
  });

  it("keeps membership when synthesis succeeds", () => {
    const result = applySelectGammaSynthesis({
      selected_candidate_keys: SELECTED,
      synthesize: () => ({ text: "one-shot summary" })
    });
    expect(result.selected_candidate_keys).toEqual(SELECTED);
    expect(result.synthesis).toEqual({
      status: "ok",
      text: "one-shot summary"
    });
  });

  it("returns evidence plus failure metadata for malformed synthesis", () => {
    const result = applySelectGammaSynthesis({
      selected_candidate_keys: SELECTED,
      synthesize: () => {
        throw new Error("provider truncated");
      }
    });
    expect(result.selected_candidate_keys).toEqual(SELECTED);
    expect(result.synthesis).toEqual({
      status: "malformed",
      failure: "provider truncated"
    });
  });

  it("returns evidence plus failure metadata for truncated synthesis", () => {
    const result = applySelectGammaSynthesis({
      selected_candidate_keys: SELECTED,
      synthesize: () => ({ text: "cut off", truncated: true })
    });
    expect(result.selected_candidate_keys).toEqual(SELECTED);
    expect(result.synthesis).toEqual({
      status: "truncated",
      failure: "synthesis output truncated",
      text: "cut off"
    });
  });

  it("cannot mutate the selected set", () => {
    const result = applySelectGammaSynthesis({
      selected_candidate_keys: SELECTED,
      synthesize: () => ({
        text: "inject",
        selected_candidate_keys: ["injected"]
      })
    });
    expect(result.selected_candidate_keys).toEqual(SELECTED);
    expect(result.selected_candidate_keys).not.toContain("injected");
  });
});
