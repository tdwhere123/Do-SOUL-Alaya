import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../cli/index.js";
import { parseFlags } from "../../cli/cli-options.js";
import { buildRecallEvalOptions } from "../../cli/recall-eval/command.js";
import { prepareRecallEvalRunContext } from
  "../../runs/lifecycle/recall-eval/recall-eval-run-context.js";

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

  it("threads the explicit warm derived snapshot receipt into recall-eval options", () => {
    const flags = parseFlags([
      "--experiment",
      "--warm-derived-snapshot-receipt",
      "/tmp/warm-derived.json"
    ]);

    expect(buildRecallEvalOptions(flags, "/tmp/snapshot.db")).toMatchObject({
      experiment: true,
      warmDerivedSnapshotReceiptPath: "/tmp/warm-derived.json"
    });
  });

  it("threads a semantics-preserving embedding cache overlay independently", () => {
    const flags = parseFlags([
      "--embedding-cache-overlay",
      "/tmp/embedding-overlay.json"
    ]);

    expect(buildRecallEvalOptions(flags, "/tmp/snapshot.db")).toMatchObject({
      embeddingCacheOverlayReceiptPath: "/tmp/embedding-overlay.json"
    });
  });

  it("rejects warm restore unless recall-eval is explicitly experimental", async () => {
    const exitCode = await runCli([
      "recall-eval",
      "--snapshot",
      "/tmp/not-read.db",
      "--warm-derived-snapshot-receipt",
      "/tmp/warm-derived.json"
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/--warm-derived-snapshot-receipt requires --experiment/u);
  });

  it("rejects combining warm restore with an inline projection rebuild", async () => {
    const exitCode = await runCli([
      "recall-eval",
      "--snapshot",
      "/tmp/not-read.db",
      "--experiment",
      "--warm-derived-snapshot-receipt",
      "/tmp/warm-derived.json",
      "--rebuild-evidence-search-projections"
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/cannot be combined/u);
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

  it("rejects direct warm restore outside experiment mode", async () => {
    await expect(prepareRecallEvalRunContext({
      snapshotDbPath: "/tmp/not-read.db",
      variant: "longmemeval_s",
      historyRoot: "/tmp/not-written",
      warmDerivedSnapshotReceiptPath: "/tmp/warm-derived.json"
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

  it("allows a historical prompt to verify an experiment snapshot without retrofit", async () => {
    const exitCode = await runCli([
      "recall-eval",
      "--snapshot",
      "/tmp/not-read.db",
      "--experiment",
      "--seed-extraction-system-prompt",
      "/tmp/historical-prompt.txt"
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).not.toMatch(/requires --fact-frame-retrofit-ledger/u);
    expect(stderr).toMatch(/not-read\.db/u);
  });

  it("keeps historical snapshot prompts experiment-only", async () => {
    const exitCode = await runCli([
      "recall-eval",
      "--snapshot",
      "/tmp/not-read.db",
      "--seed-extraction-system-prompt",
      "/tmp/historical-prompt.txt"
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/--seed-extraction-system-prompt requires --experiment/u);
  });
});
