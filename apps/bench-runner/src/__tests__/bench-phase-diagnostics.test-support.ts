import { availableParallelism, cpus, totalmem } from "node:os";
import { basename } from "node:path";

type Phase = { phase: string; started: number; ms: number; failed: boolean };
type Trace = { active: Set<Phase>; completed: Map<string, { count: number; ms: number }>; slowest: Phase[]; last?: Phase };
let hardwareReported = false;

/** Called only by the three instrumented integration files, using their existing Vitest timeout. */
export function startBenchPhaseDiagnostics(
  filepath: string, testId: string, timeout: number, signal: AbortSignal,
  emit: (line: string) => void = line => { process.stderr.write(`${line}\n`); }
): { phase<T>(name: string, body: () => Promise<T>): Promise<T>; finish(failed: boolean): void } {
  const trace: Trace = { active: new Set(), completed: new Map(), slowest: [] };
  /** Explicitly awaited test phases preserve rejection behavior; no runtime functions are replaced. */
  async function phase<T>(name: string, body: () => Promise<T>): Promise<T> {
    const row: Phase = { phase: name, started: performance.now(), ms: 0, failed: false };
    trace.active.add(row);
    try { return await body(); }
    catch (error) { row.failed = true; throw error; }
    finally {
      row.ms = Math.round(performance.now() - row.started);
      trace.active.delete(row);
      trace.last = row;
      const total = trace.completed.get(name) ?? { count: 0, ms: 0 };
      total.count += 1; total.ms += row.ms;
      trace.completed.set(name, total);
      trace.slowest.push(row);
      trace.slowest.sort((left, right) => right.ms - left.ms);
      trace.slowest.length = Math.min(3, trace.slowest.length);
    }
  }

  const started = performance.now(), cpu = process.cpuUsage();
  const active = () => [...trace.active].slice(-6).map(row => ({ phase: row.phase,
    ms: Math.round(performance.now() - row.started) }));
  let atAbort: ReturnType<typeof active> | undefined;
  const onAbort = () => { atAbort = active(); };
  signal.addEventListener("abort", onAbort, { once: true });
  let slow = false, finished = false;
  const summary = ({ phase, ms, failed }: Phase) => ({ phase, ms, failed });
  function report(event: "budget_75pct" | "finished", failed = false) {
    const usage = process.cpuUsage(cpu);
    const hardware = hardwareReported ? undefined : { platform: process.platform,
      availableParallelism: availableParallelism(), cpuCount: cpus().length, totalMemoryMB: Math.round(totalmem() / 1024 ** 2) };
    hardwareReported = true;
    emit(`[bench-phase] ${JSON.stringify({ event, file: basename(filepath), testId, pid: process.pid,
      timeoutMs: timeout, elapsedMs: Math.round(performance.now() - started), failed, hardware,
      cpuMs: Math.round((usage.user + usage.system) / 1000), totals: Object.fromEntries(trace.completed),
      active: active(), atAbort, last: trace.last === undefined ? undefined : summary(trace.last),
      slowest: trace.slowest.map(summary) })}`);
  }
  const timer = timeout > 0 ? setTimeout(() => { slow = true; report("budget_75pct"); }, timeout * 0.75) : undefined;
  timer?.unref();
  return { phase, finish(failed) {
    if (finished) return;
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    if (failed || slow || (timeout > 0 && performance.now() - started >= timeout * 0.75)) report("finished", failed);
  } };
}
