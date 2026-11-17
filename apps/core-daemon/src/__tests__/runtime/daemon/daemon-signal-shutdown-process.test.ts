import { ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const shutdownModule = new URL("../../../../dist/runtime/daemon/lifecycle/daemon-signal-shutdown.js", import.meta.url).href;
const timingModule = new URL("./daemon-runtime-timing.js", shutdownModule).href;
const guard = new URL("../../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href;
const transports = process.platform === "win32" ? ["ipc"] as const : ["signal", "ipc"] as const;
type Scenario = "complete" | "failure" | "second-signal";

async function runShutdownChild(scenario: Scenario, transport: "signal" | "ipc") {
  const useIpc = transport === "ipc";
  const source = `
    import { installSignalShutdownHandler } from ${JSON.stringify(shutdownModule)};
    import { defaultLifecycleTimerPort } from ${JSON.stringify(timingModule)};
    const scenario = ${JSON.stringify(scenario)};
    const state = { signalShutdownTimeout: null };
    const shutdown = async () => {
      process.stdout.write("shutdown-called\\n");
      if (scenario === "failure") throw new Error("shutdown-fixture-failure");
      if (scenario === "second-signal") await new Promise(() => {});
    };
    for (const signal of ["SIGTERM", "SIGINT"]) {
      installSignalShutdownHandler({
        signal, processPort: process, timerPort: defaultLifecycleTimerPort, state, shutdown,
        warnLogger: { warn(message) { process.stdout.write(message + "\\n"); } }
      });
    }
    // Windows kill() terminates the child instead of dispatching a catchable signal.
    // Drive the installed process listeners over IPC there; POSIX uses real OS signals.
    if (${useIpc}) process.on("message", signal => process.emit(signal, signal));
    setInterval(() => {}, 1000);
    process.stdout.write("ready\\n");
  `;
  const child = spawn(process.execPath, ["--import", guard, "--input-type=module", "--eval", source], {
    stdio: useIpc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"]
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  ok(child.stdout && child.stderr, "shutdown child must have piped output");
  let stdout = "";
  let stderr = "";
  const deliverSignal = (signal: "SIGTERM" | "SIGINT") => {
    if (useIpc) child.send(signal);
    else child.kill(signal);
  };
  let signalCount = 0;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (signalCount === 0 && stdout.includes("ready\n")) {
      signalCount = 1;
      deliverSignal("SIGTERM");
    }
    if (scenario === "second-signal" && signalCount === 1 && stdout.includes("shutdown-called\n")) {
      signalCount = 2;
      deliverSignal("SIGINT");
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    return { ...exit, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

describe.each(transports)("daemon signal shutdown in a child process (%s)", (transport) => {
  it.each([
    ["complete", 0, "shutdown-called"],
    ["failure", 1, "daemon shutdown failed after SIGTERM"],
    ["second-signal", 1, "received second SIGINT, forcing immediate exit"]
  ] as const)("exits after %s with the existing status", async (scenario, code, message) => {
    const result = await runShutdownChild(scenario, transport);
    expect(result, result.stderr).toMatchObject({ code, signal: null });
    expect(result.stdout).toContain(message);
    expect(result.stdout.match(/shutdown-called/g)).toHaveLength(1);
  }, 15_000);
});
