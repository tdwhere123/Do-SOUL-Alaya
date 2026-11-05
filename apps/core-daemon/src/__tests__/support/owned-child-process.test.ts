import { describe, expect, it } from "vitest";
import { startOwnedTestChild } from "./owned-child-process.js";

const waitingScript = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";

describe("owned fixture child lifetime", () => {
  it("reports an early exit and joins it again without waiting for another exit event", async ({ signal }) => {
    const running = startOwnedTestChild(["-e", "process.stderr.write('startup failed'); process.exit(17);"], signal);
    try {
      await expect(running.waitForStdout("ready\n")).rejects.toThrow("startup failed");
      expect(await running.closed).toEqual({ code: 17, signal: null });
      expect(await running.stop()).toEqual({ code: 17, signal: null });
      await expect(running.waitForStdout("ready\n")).rejects.toThrow("startup failed");
    } finally { await running.stop(); }
  });

  it("kills and joins the actual child when its test is cancelled before readiness", async () => {
    const controller = new AbortController();
    const running = startOwnedTestChild(["-e", waitingScript], controller.signal);
    const readiness = expect(running.waitForStdout("unreachable\n")).rejects.toThrow("test cancelled");
    let closed = false;
    running.child.once("close", () => { closed = true; });
    try {
      controller.abort(new Error("test cancelled"));
      expect(await running.stop()).toEqual({ code: null, signal: "SIGKILL" });
      await readiness;
      expect(closed).toBe(true);
    } finally { await running.stop(); }
  });

  it("joins a normally killed child before fixture cleanup and supports repeated cleanup", async ({ signal }) => {
    const running = startOwnedTestChild(["-e", waitingScript], signal);
    let closed = false;
    running.child.once("close", () => { closed = true; });
    try {
      await running.waitForStdout("ready\n");
      expect(await running.stop()).toEqual({ code: null, signal: "SIGKILL" });
      expect(closed).toBe(true);
      expect(await running.stop()).toEqual({ code: null, signal: "SIGKILL" });
    } finally { await running.stop(); }
  });

  it("does not spawn after cancellation", () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    expect(() => startOwnedTestChild(["-e", waitingScript], controller.signal)).toThrow("already cancelled");
  });
});
