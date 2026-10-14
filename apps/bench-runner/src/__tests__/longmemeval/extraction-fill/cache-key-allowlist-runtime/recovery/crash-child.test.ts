import { describe, expect, it } from "vitest";
import { startCatalogRefillCrashChild } from "./crash-child.js";

const input = {
  mode: "provider-failure" as const, variant: "longmemeval_oracle",
  cacheRoot: "unused-before-runtime-start", dataDir: "unused-before-runtime-start",
  pinnedMetaRoot: "unused-before-runtime-start", authorityReceiptPath: "unused-before-runtime-start",
  targetSelectionReceiptPath: "unused-before-runtime-start"
};
const phase = "failure-manifest-published";

describe.skipIf(process.platform === "win32")("catalog refill crash child ownership", () => {
  it("joins the actual child on test cancellation before cleanup continues", async () => {
    const controller = new AbortController();
    const running = startCatalogRefillCrashChild(input, phase, controller.signal);
    let closed = false;
    running.child.once("close", () => { closed = true; });
    try {
      expect(running.child.pid).toBeDefined();
      controller.abort(new Error("test deadline elapsed"));
      await running.stop();
      expect(closed).toBe(true);
      expect(await running.closed).toMatchObject({ code: null, signal: "SIGKILL" });
      expect(() => process.kill(running.child.pid!, 0)).toThrow();
    } finally { await running.stop(); }
  });

  it("joins the actual child when fixture cleanup runs without cancellation", async () => {
    const running = startCatalogRefillCrashChild(input, phase, new AbortController().signal);
    try {
      await running.stop();
      expect(await running.closed).toMatchObject({ code: null, signal: "SIGKILL" });
      expect(() => process.kill(running.child.pid!, 0)).toThrow();
      await running.stop();
    } finally { await running.stop(); }
  });

  it("does not spawn after the test has already been cancelled", () => {
    const controller = new AbortController();
    const reason = new Error("test deadline elapsed");
    controller.abort(reason);
    expect(() => startCatalogRefillCrashChild(input, phase, controller.signal)).toThrow(reason);
  });
});
