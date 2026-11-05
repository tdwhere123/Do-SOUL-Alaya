import { spawn, type SpawnOptions } from "node:child_process";

/** Joins the same close event on success, startup failure, cancellation, and cleanup. */
export function startOwnedTestChild(
  args: readonly string[],
  signal: AbortSignal,
  options: Pick<SpawnOptions, "cwd" | "env"> = {}
) {
  signal.throwIfAborted();
  const child = spawn(process.execPath, [...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  let spawnError: Error | undefined;
  let closedAlready = false;
  child.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-12_000); });
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-12_000); });
  const kill = () => { if (!closedAlready) child.kill("SIGKILL"); };
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("error", error => { spawnError = error; });
    child.once("close", (code, exitSignal) => {
      closedAlready = true;
      signal.removeEventListener("abort", kill);
      resolve({ code, signal: exitSignal });
    });
  });
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();

  const waitForStdout = async (marker: string): Promise<void> => {
    signal.throwIfAborted();
    if (stdout.includes(marker)) return;
    let receive = () => {};
    try {
      await Promise.race([
        new Promise<void>(resolve => {
          receive = () => { if (stdout.includes(marker)) resolve(); };
          child.stdout.on("data", receive);
        }),
        closed.then(({ code, signal: exitSignal }) => {
          signal.throwIfAborted();
          throw spawnError ?? new Error(`Fixture child exited before ${JSON.stringify(marker)}: ${code ?? exitSignal}\n${stderr}`);
        })
      ]);
      signal.throwIfAborted();
    } finally {
      child.stdout.off("data", receive);
    }
  };
  const stop = async () => { kill(); return await closed; };
  return { child, closed, waitForStdout, stop };
}
