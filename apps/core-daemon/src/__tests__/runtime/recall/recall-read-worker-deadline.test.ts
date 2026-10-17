import { afterEach, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { RecallReadWorkerDeadline } from "../../../runtime/recall/recall-read-worker-deadline.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

it("does not invoke work for a preaborted caller and preserves its original reason through disposal", async () => {
  const controller = new AbortController(), reason = new Error("caller abandoned request");
  controller.abort(reason);
  const deadline = new RecallReadWorkerDeadline("caller", 1000, controller.signal), work = vi.fn(async () => undefined);
  try {
    await expect(deadline.run(work)).rejects.toBe(reason);
    expect(work).not.toHaveBeenCalled();
  } finally { deadline.dispose(); }
  expect(deadline.signal.reason).toBe(reason);
});

it("retires returned scopes permanently rather than merely clearing their timer and abort link", async () => {
  const controller = new AbortController(), deadline = new RecallReadWorkerDeadline("returned", 1000, controller.signal);
  await expect(deadline.run(async () => "observed")).resolves.toBe("observed");
  deadline.dispose();
  const retired = deadline.signal.reason;
  expect(deadline.signal.aborted).toBe(true);
  expect(() => deadline.check()).toThrow(/execution scope is no longer active/u);
  const escaped = vi.fn(async () => "must not run");
  await expect(deadline.run(escaped)).rejects.toBe(retired);
  expect(escaped).not.toHaveBeenCalled();
  controller.abort(new Error("later cancellation"));
  deadline.dispose();
  expect(deadline.signal.reason).toBe(retired);
});

it("settles retirement without pretending the ignored asynchronous work synchronously stopped", async () => {
  const deadline = new RecallReadWorkerDeadline("unfinished", 1000), release = deferred();
  let physicallyFinished = false;
  const operation = deadline.run(async () => { await release.promise; physicallyFinished = true; return "late"; });
  const rejected = expect(operation).rejects.toThrow(/execution scope is no longer active/u);
  deadline.dispose();
  await rejected;
  expect(physicallyFinished).toBe(false);
  release.resolve();
  await Promise.resolve();
  expect(physicallyFinished).toBe(true);
  await expect(operation).rejects.toBe(deadline.signal.reason);
});

it("checks the monotonic clock even when an overdue timer has not yet executed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const deadline = new RecallReadWorkerDeadline("clock", 100);
  try {
    now = 99; expect(deadline.remainingMs()).toBe(1);
    now = 100;
    expect(() => deadline.check()).toThrow(/timed out after 100ms/u);
    const work = vi.fn(async () => undefined);
    await expect(deadline.run(work)).rejects.toBe(deadline.signal.reason);
    expect(work).not.toHaveBeenCalled();
  } finally { deadline.dispose(); }
});

it("clamps monotonic roundoff so remaining cannot exceed the original timeout maximum", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // (now + 60000) - now exceeds 60000 at this timestamp; remaining must keep the original maximum.
  let now = 5536.123456789;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const deadline = new RecallReadWorkerDeadline("ceiling", 60_000);
  try {
    expect((now + 60_000) - now).toBeGreaterThan(60_000);
    expect(deadline.remainingMs()).toBe(60_000);
    now += 10;
    expect(deadline.remainingMs()).toBe(59_990);
    now += 59_989;
    expect(deadline.remainingMs()).toBe(1);
    now += 1;
    expect(() => deadline.check()).toThrow(/timed out after 60000ms/u);
  } finally { deadline.dispose(); }
});
