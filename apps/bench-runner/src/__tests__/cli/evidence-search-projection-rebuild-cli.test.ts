import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../cli/index.js";
import { parseFlags } from "../../cli/cli-options.js";
import { buildRecallEvalOptions } from "../../cli/recall-eval/command.js";
import { prepareRecallEvalRunContext } from
  "../../longmemeval/lifecycle/recall-eval/recall-eval-run-context.js";

describe("recall-eval derived evidence projection rebuild boundary", () => {
  let originalStderrWrite: typeof process.stderr.write;
  let stderr: string;

  beforeEach(() => {
    stderr = "";
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  it("rejects the rebuild unless recall-eval is explicitly experimental", async () => {
    const exitCode = await runCli([
      "recall-eval",
      "--snapshot",
      "/tmp/not-read.db",
      "--rebuild-evidence-search-projections"
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(
      /--rebuild-evidence-search-projections requires --experiment/u
    );
  });

  it("threads the explicit experiment-only rebuild into recall-eval options", () => {
    const flags = parseFlags([
      "--experiment",
      "--rebuild-evidence-search-projections"
    ]);

    expect(buildRecallEvalOptions(flags, "/tmp/snapshot.db")).toMatchObject({
      experiment: true,
      derivedEvidenceProjectionRebuild: true
    });
  });

  it("rejects direct non-experiment access before reading a snapshot", async () => {
    await expect(prepareRecallEvalRunContext({
      snapshotDbPath: "/tmp/not-read.db",
      variant: "longmemeval_s",
      historyRoot: "/tmp/not-written",
      derivedEvidenceProjectionRebuild: true
    }, undefined, {})).rejects.toThrow(/requires experiment mode/u);
  });
});
