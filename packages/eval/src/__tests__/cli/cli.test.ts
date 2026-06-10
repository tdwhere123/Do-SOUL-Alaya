import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../cli.js";

describe("alaya-eval CLI", () => {
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let stdoutBuf: string;
  let stderrBuf: string;

  beforeEach(() => {
    stdoutBuf = "";
    stderrBuf = "";
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutBuf += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrBuf += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  it("lists all supported bench names in help", async () => {
    const exitCode = await runCli(["--help"]);

    expect(exitCode).toBe(0);
    expect(stdoutBuf).toContain(
      "bench-name = self | public | public-multiturn | public-crossquestion | public-locomo | live"
    );
  });

  it("lists all supported bench names in invalid bench errors", async () => {
    const diffExitCode = await runCli(["diff", "unknown"]);

    expect(diffExitCode).toBe(2);
    expect(stderrBuf).toContain(
      "expected self | public | public-multiturn | public-crossquestion | public-locomo | live"
    );

    stderrBuf = "";
    const listExitCode = await runCli(["list", "unknown"]);

    expect(listExitCode).toBe(2);
    expect(stderrBuf).toContain(
      "expected self | public | public-multiturn | public-crossquestion | public-locomo | live"
    );
  });
});
