import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";

describe("bench-runner CLI", () => {
  let originalStderrWrite: typeof process.stderr.write;
  let stderrBuf: string;

  beforeEach(() => {
    stderrBuf = "";
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrBuf += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  it("rejects invalid embedding modes instead of silently disabling embeddings", async () => {
    const exitCode = await runCli(["longmemeval", "--embedding", "evn"]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/--embedding must be one of: disabled, env/);
  });
});
