import { describe, expect, it } from "vitest";
import { assertPagerContinuationBinding, pagerSwitchWorkingDataDir } from "../../../runs/lifecycle/recall-eval/recall-eval-process/child-runtime.js";

describe("recall-eval path-switch working dirs", () => {
  it("assigns a different private working-copy path per switch", () => {
    const first = pagerSwitchWorkingDataDir("/tmp/data", 1, "ws-a");
    const second = pagerSwitchWorkingDataDir("/tmp/data", 2, "ws-b");
    expect(first).not.toBe(second);
    expect(first).toContain("pager-working");
    expect(second).toContain("pager-working");
  });

  it("retains only the same question/source fingerprint and working inode", () => {
    const active = { requestIdentity: "question+source", workingFileIdentity: "1:2" };
    expect(() => assertPagerContinuationBinding(active, { ...active })).not.toThrow();
    expect(() => assertPagerContinuationBinding(null, active)).toThrow(/continuation invalidated/);
    expect(() => assertPagerContinuationBinding(active, { ...active, requestIdentity: "other-question" }))
      .toThrow(/continuation invalidated/);
    expect(() => assertPagerContinuationBinding(active, { ...active, workingFileIdentity: "1:3" }))
      .toThrow(/continuation invalidated/);
    expect(() => assertPagerContinuationBinding(active, { ...active, workingFileIdentity: "unavailable" }))
      .toThrow(/continuation invalidated/);
  });
});
