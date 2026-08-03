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
      "--rebuild-evidence-search-projections",
      "--fact-frame-retrofit-ledger",
      "/tmp/fact-frames.ndjson",
      "--seed-extraction-system-prompt",
      "/tmp/historical-prompt.txt"
    ]);

    expect(buildRecallEvalOptions(flags, "/tmp/snapshot.db")).toMatchObject({
      experiment: true,
      derivedEvidenceProjectionRebuild: true,
      factFrameRetrofitLedgerPath: "/tmp/fact-frames.ndjson",
      seedExtractionSystemPromptPath: "/tmp/historical-prompt.txt"
    });
  });

  it("rejects a retrofit ledger without the explicit rebuild boundary", async () => {
    const exitCode = await runCli([
      "recall-eval",
      "--snapshot",
      "/tmp/not-read.db",
      "--experiment",
      "--fact-frame-retrofit-ledger",
      "/tmp/fact-frames.ndjson"
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(
      /--fact-frame-retrofit-ledger requires --rebuild-evidence-search-projections/u
    );
  });

  it("rejects direct non-experiment access before reading a snapshot", async () => {
    await expect(prepareRecallEvalRunContext({
      snapshotDbPath: "/tmp/not-read.db",
      variant: "longmemeval_s",
      historyRoot: "/tmp/not-written",
      derivedEvidenceProjectionRebuild: true
    }, undefined, {})).rejects.toThrow(/requires experiment mode/u);
  });

  it("rejects a direct retrofit ledger without projection rebuild", async () => {
    await expect(prepareRecallEvalRunContext({
      snapshotDbPath: "/tmp/not-read.db",
      variant: "longmemeval_s",
      historyRoot: "/tmp/not-written",
      experiment: true,
      factFrameRetrofitLedgerPath: "/tmp/fact-frames.ndjson"
    }, undefined, {})).rejects.toThrow(/requires derived evidence projection rebuild/u);
  });

  it("rejects a historical prompt without a digest-bound retrofit ledger", async () => {
    const exitCode = await runCli([
      "recall-eval",
      "--snapshot",
      "/tmp/not-read.db",
      "--experiment",
      "--rebuild-evidence-search-projections",
      "--seed-extraction-system-prompt",
      "/tmp/historical-prompt.txt"
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(
      /--seed-extraction-system-prompt requires --fact-frame-retrofit-ledger/u
    );
  });
});
