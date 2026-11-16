import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const shutdownModule = new URL("../../../../dist/runtime/daemon/lifecycle/daemon-signal-shutdown.js", import.meta.url).href;
const timingModule = new URL("./daemon-runtime-timing.js", shutdownModule).href;
const guard = fileURLToPath(new URL("../../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url));
type Scenario = "complete" | "failure" | "second-signal";

async function runShutdownChild(scenario: Scenario) {
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
    setInterval(() => {}, 1000);
    process.stdout.write("ready\\n");
  `;
  const child = spawn(process.execPath, ["--import", guard, "--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  let stdout = "";
  let stderr = "";
  let signalCount = 0;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (signalCount === 0 && stdout.includes("ready\n")) {
      signalCount = 1;
      child.kill("SIGTERM");
    }
    if (scenario === "second-signal" && signalCount === 1 && stdout.includes("shutdown-called\n")) {
      signalCount = 2;
      child.kill("SIGINT");
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

describe("daemon signal shutdown through OS processes", () => {
  it.each([
    ["complete", 0, "shutdown-called"],
    ["failure", 1, "daemon shutdown failed after SIGTERM"],
    ["second-signal", 1, "received second SIGINT, forcing immediate exit"]
  ] as const)("exits after %s with the existing status", async (scenario, code, message) => {
    const result = await runShutdownChild(scenario);
    expect(result, result.stderr).toMatchObject({ code, signal: null });
    expect(result.stdout).toContain(message);
    expect(result.stdout.match(/shutdown-called/g)).toHaveLength(1);
  }, 15_000);
});
