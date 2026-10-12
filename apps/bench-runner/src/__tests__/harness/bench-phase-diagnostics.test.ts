import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { startBenchPhaseDiagnostics } from "../bench-phase-diagnostics.test-support.js";

it("preserves phase results and errors while logging only bounded fixed-label timing", async () => {
  const lines: string[] = [];
  const diagnostics = startBenchPhaseDiagnostics("/private/native-original-evidence-recovery.test.ts", "probe", 60_000,
    new AbortController().signal, line => { lines.push(line); });
  const benchPhase = diagnostics.phase;
  try {
    expect(await benchPhase("snapshot.native", async () => "private-result")).toBe("private-result");
    const error = new Error("private-error");
    await expect(benchPhase("fill.source", async () => { throw error; })).rejects.toBe(error);
    expect(lines).toHaveLength(0);
    diagnostics.finish(true);
    diagnostics.finish(true);
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]!.slice("[bench-phase] ".length));
    expect(report.totals["snapshot.native"].count).toBe(1);
    expect(report.last).toMatchObject({ phase: "fill.source", failed: true });
    expect(report.active).toEqual([]);
    expect(Object.keys(report.hardware).sort()).toEqual(["availableParallelism", "cpuCount", "platform", "totalMemoryMB"]);
    expect(report.slowest.length).toBeLessThanOrEqual(3);
    expect(lines[0]).not.toContain("private");
  } finally { diagnostics.finish(false); }
});

it("reports the existing budget once, captures active cancellation, and clears the watchdog", async () => {
  vi.useFakeTimers();
  const lines: string[] = [], controller = new AbortController();
  const diagnostics = startBenchPhaseDiagnostics("native-source-records-snapshot.test.ts", "probe", 60_000,
    controller.signal, line => { lines.push(line); });
  const benchPhase = diagnostics.phase;
  let release: () => void = () => undefined;
  const pending = benchPhase("snapshot.publish", () => new Promise<void>(resolve => { release = resolve; }));
  try {
    await vi.advanceTimersByTimeAsync(44_999);
    expect(lines).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"event":"budget_75pct"');
    controller.abort(); release(); await pending;
    diagnostics.finish(false);
    const final = JSON.parse(lines[1]!.slice("[bench-phase] ".length));
    expect(final.atAbort).toEqual([{ phase: "snapshot.publish", ms: expect.any(Number) }]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(lines).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release(); await pending; diagnostics.finish(false); vi.useRealTimers();
  }
});

it.each([false, true])("preserves native unhandled-rejection behavior when caught=%s", handled => {
  const moduleUrl = new URL("../bench-phase-diagnostics.test-support.ts", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { startBenchPhaseDiagnostics } from ${JSON.stringify(moduleUrl)};
    let unhandled = 0; const lines = [];
    process.on('unhandledRejection', () => { unhandled += 1; });
    const trace = startBenchPhaseDiagnostics('probe.test.ts', 'probe', 60000,
      new AbortController().signal, line => lines.push(line));
    const pending = trace.phase('probe', async () => { throw new Error('probe'); });
    if (${handled}) pending.catch(() => undefined);
    setImmediate(() => {
      trace.finish(true);
      console.log(JSON.stringify({ unhandled, phases: JSON.parse(lines[0].slice(14)).totals.probe.count }));
    });
  `], { encoding: "utf8", timeout: 10_000 });
  expect(JSON.parse(output)).toEqual({ unhandled: handled ? 0 : 1, phases: 1 });
});
