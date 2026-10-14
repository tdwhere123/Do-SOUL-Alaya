import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

interface CrashChildInput {
  readonly mode: "partial-result" | "provider-failure";
  readonly variant: string;
  readonly cacheRoot: string;
  readonly dataDir: string;
  readonly pinnedMetaRoot: string;
  readonly authorityReceiptPath: string;
  readonly targetSelectionReceiptPath: string;
}

export function startCatalogRefillCrashChild(
  input: CrashChildInput,
  phase: "in-progress-result-manifest-published" | "failure-manifest-published",
  signal: AbortSignal
) {
  signal.throwIfAborted();
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("./crash-fixture.mjs", import.meta.url))
  ], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ALAYA_TEST_CATALOG_REFILL_CRASH_CHILD: JSON.stringify(input),
      ALAYA_TEST_CATALOG_REFILL_SIGKILL_AFTER: phase }
  });
  let output = "";
  let spawnError: Error | undefined;
  let closedAlready = false;
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-12_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  // Even a spawn error is joined through close before fixture directories can be removed.
  const closed = new Promise<{
    readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly output: string;
  }>((resolve, reject) => {
    child.once("error", error => { spawnError = error; });
    child.once("close", (code, exitSignal) => {
      closedAlready = true;
      signal.removeEventListener("abort", abort);
      if (spawnError !== undefined) reject(spawnError);
      else resolve({ code, signal: exitSignal, output });
    });
  });
  const abort = () => { if (!closedAlready) child.kill("SIGKILL"); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const stop = async () => {
    abort();
    await Promise.allSettled([closed]);
  };
  return { child, closed, stop };
}
