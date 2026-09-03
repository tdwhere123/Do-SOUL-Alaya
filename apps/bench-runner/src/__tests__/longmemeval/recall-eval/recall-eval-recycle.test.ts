import { describe, expect, it } from "vitest";
import { pagerSwitchWorkingDataDir } from "../../../runs/lifecycle/recall-eval/recall-eval-process/child-runtime.js";

describe("recall-eval path-switch working dirs", () => {
  it("assigns a different private working-copy path per switch", () => {
    const first = pagerSwitchWorkingDataDir("/tmp/data", 1, "ws-a");
    const second = pagerSwitchWorkingDataDir("/tmp/data", 2, "ws-b");
    expect(first).not.toBe(second);
    expect(first).toContain("pager-working");
    expect(second).toContain("pager-working");
  });
});
