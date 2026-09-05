import { afterEach, expect, it, vi } from "vitest";
import { parseFlags, type ParsedFlags } from "../../../cli/cli-options.js";
import { peelExtractionFillLazyFlags } from "../../../cli/extraction-fill/lazy-field-flags.js";
import { ExtractionFillTaskError } from
  "../../../runs/extraction/fill/fill-pool.js";
import { emptyBenchTerminalRetryClassifications } from
  "../../../runs/compile-seed/compile-seed-types.js";

const mocks = vi.hoisted(() => ({
  fallbackRun: vi.fn(async () => {
    throw new Error("signal dependency injection missing");
  })
}));

vi.mock("../../../runs/extraction/extraction-fill.js", () => ({
  runExtractionFill: mocks.fallbackRun
}));

import { runExtractionFillCommand } from "../../../cli/cli-commands.js";

type FillSignal = "SIGINT" | "SIGTERM";
type SignalHandler = () => void;

class FakeSignalSource {
  private readonly handlers = new Map<FillSignal, Set<SignalHandler>>();

  on(signal: FillSignal, handler: SignalHandler): void {
    const current = this.handlers.get(signal) ?? new Set();
    current.add(handler);
    this.handlers.set(signal, current);
  }

  off(signal: FillSignal, handler: SignalHandler): void {
    this.handlers.get(signal)?.delete(handler);
  }

  emit(signal: FillSignal): void {
    for (const handler of this.handlers.get(signal) ?? []) handler();
  }

  listenerCount(): number {
    return [...this.handlers.values()].reduce((sum, handlers) => sum + handlers.size, 0);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("routes a bare extraction-fill command through the cache-only runtime", async () => {
  const signalSource = new FakeSignalSource();
  const run = vi.fn(async () => completedFillResult());
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const command = runExtractionFillCommand as unknown as (
    opts: ParsedFlags,
    dependencies: { readonly runExtractionFill: typeof run; readonly signalSource: FakeSignalSource }
  ) => Promise<number>;

  const exitCode = await command(
    { variant: "longmemeval_oracle" } as ParsedFlags,
    { runExtractionFill: run, signalSource }
  );

  expect(exitCode).toBe(0);
  expect(run).toHaveBeenCalledWith(expect.not.objectContaining({
    authorityReceiptPath: expect.anything()
  }));
  expect(stderr).not.toHaveBeenCalled();
});

it("renders a bounded cause summary for a terminal fill failure", async () => {
  const signalSource = new FakeSignalSource();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const run = vi.fn(async () => {
    throw new ExtractionFillTaskError({
      retryClassification: "unknown",
      retrySuccesses: 0,
      rateLimitRetries: 0,
      processedTurns: 6,
      requestedTurns: 13_998,
      cause: new Error("semantic graph validation failed")
    });
  });
  const command = runExtractionFillCommand as unknown as (
    opts: ParsedFlags,
    dependencies: { readonly runExtractionFill: typeof run; readonly signalSource: FakeSignalSource }
  ) => Promise<number>;

  const exitCode = await command(
    { variant: "longmemeval_s" } as ParsedFlags,
    { runExtractionFill: run, signalSource }
  );

  expect(exitCode).toBe(1);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
    "cause=Error"
  ));
});

it("rejects a predecessor receipt without its child extraction authority", async () => {
  const signalSource = new FakeSignalSource();
  const run = vi.fn(async () => completedFillResult());
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const command = runExtractionFillCommand as unknown as (
    opts: ParsedFlags,
    dependencies: { readonly runExtractionFill: typeof run; readonly signalSource: FakeSignalSource }
  ) => Promise<number>;

  const exitCode = await command({
    variant: "longmemeval_s",
    extractionPredecessorAuthority: "/fixture/predecessor.json"
  } as ParsedFlags, { runExtractionFill: run, signalSource });

  expect(exitCode).toBe(2);
  expect(run).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/requires --extraction-authority/u));
});

it("loads the R3 approval file before handing the fill to the runtime gate", async () => {
  const signalSource = new FakeSignalSource();
  const approval = { kind: "r3" };
  const readR3SpendApproval = vi.fn(() => approval);
  const run = vi.fn(async () => completedFillResult());
  const command = runExtractionFillCommand as unknown as (
    opts: ParsedFlags,
    dependencies: {
      readonly runExtractionFill: typeof run;
      readonly signalSource: FakeSignalSource;
      readonly readR3SpendApproval: typeof readR3SpendApproval;
    }
  ) => Promise<number>;

  const exitCode = await command({
    variant: "longmemeval_oracle",
    extractionAuthority: "/fixture/extraction-authority.json",
    r3SpendApproval: "/fixture/r3-spend-approval.json"
  } as ParsedFlags, { runExtractionFill: run, signalSource, readR3SpendApproval });

  expect(exitCode).toBe(0);
  expect(readR3SpendApproval).toHaveBeenCalledWith("/fixture/r3-spend-approval.json");
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ r3SpendApproval: approval }));
});

it("fail-closes when an R3 spend path is set but the reader dep is missing", async () => {
  const signalSource = new FakeSignalSource();
  const run = vi.fn(async () => completedFillResult());
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const command = runExtractionFillCommand as unknown as (
    opts: ParsedFlags,
    dependencies: { readonly runExtractionFill: typeof run; readonly signalSource: FakeSignalSource }
  ) => Promise<number>;

  const exitCode = await command({
    variant: "longmemeval_oracle",
    extractionAuthority: "/fixture/extraction-authority.json",
    r3SpendApproval: "/fixture/r3-spend-approval.json"
  } as ParsedFlags, { runExtractionFill: run, signalSource });

  expect(exitCode).toBe(2);
  expect(run).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(
    expect.stringMatching(/R3 spend approval reader is unavailable/u)
  );
});

it("passes an explicit extraction initial concurrency to the fill runtime", async () => {
  const signalSource = new FakeSignalSource();
  const run = vi.fn(async () => completedFillResult());
  const command = runExtractionFillCommand as unknown as (
    opts: ParsedFlags,
    dependencies: { readonly runExtractionFill: typeof run; readonly signalSource: FakeSignalSource }
  ) => Promise<number>;

  const exitCode = await command({
    variant: "longmemeval_s",
    concurrency: 32,
    extractionInitialConcurrency: 8
  } as ParsedFlags, { runExtractionFill: run, signalSource });

  expect(exitCode).toBe(0);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({
    concurrency: 32,
    initialConcurrency: 8
  }));
});

it("parses lazy_field flags and hands overlay receipt fields back from fill", async () => {
  const peeled = peelExtractionFillLazyFlags([
    "--variant", "s",
    "--ingestion-mode", "lazy_field",
    "--semantic-artifact-root", "/tmp/semantic-overlay",
    "--semantic-max-calls", "4",
    "--semantic-max-failures", "1"
  ]);
  const parsed = parseFlags(peeled.rest);
  expect(parsed).toMatchObject({
    variant: "longmemeval_s"
  });
  expect(peeled.lazy).toMatchObject({
    ingestionMode: "lazy_field",
    semanticArtifactRoot: "/tmp/semantic-overlay",
    semanticMaxCalls: 4,
    semanticMaxFailures: 1
  });

  const signalSource = new FakeSignalSource();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const run = vi.fn(async () => ({
    ...completedFillResult(),
    semanticOverlayIdentity: "aa".repeat(32),
    semanticNewlyExtracted: 2,
    semanticCacheHits: 1,
    semanticUnavailable: 0,
    lazySemanticRunReceipt: { runIdentity: "bb".repeat(32) }
  }));

  const exitCode = await runExtractionFillCommand(
    parsed,
    { runExtractionFill: run as never, signalSource },
    peeled.lazy
  );

  expect(exitCode).toBe(0);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({
    ingestionMode: "lazy_field",
    semanticArtifactRoot: "/tmp/semantic-overlay",
    semanticMaxCalls: 4,
    semanticMaxFailures: 1
  }));
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("semantic_overlay="));
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("lazy_run="));
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("semantic_newly_extracted=2"));
});

it("passes explicit provider task failure isolation to the fill runtime", async () => {
  const signalSource = new FakeSignalSource();
  const run = vi.fn(async () => completedFillResult());
  const command = runExtractionFillCommand as unknown as (
    opts: ParsedFlags,
    dependencies: { readonly runExtractionFill: typeof run; readonly signalSource: FakeSignalSource }
  ) => Promise<number>;

  const exitCode = await command({
    variant: "longmemeval_s",
    tolerateProviderTaskFailures: true
  } as ParsedFlags, { runExtractionFill: run, signalSource });

  expect(exitCode).toBe(0);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({
    tolerateProviderTaskFailures: true
  }));
});

it.each([
  ["SIGINT", 130],
  ["SIGTERM", 143]
] as const)("maps %s to exit code %i after abort settlement", async (signal, exitCode) => {
  const signalSource = new FakeSignalSource();
  const run = vi.fn(async (options: { readonly signal?: AbortSignal }) => {
    signalSource.emit(signal);
    options.signal?.throwIfAborted();
    throw new Error("signal was not wired to extraction-fill");
  });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const actual = await invokeCommand({
    runExtractionFill: run,
    signalSource
  });

  expect(actual).toBe(exitCode);
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  expect(signalSource.listenerCount()).toBe(0);
  expect(stderr).not.toHaveBeenCalledWith(
    expect.stringContaining("signal was not wired")
  );
});

async function invokeCommand(deps: {
  readonly runExtractionFill: (
    options: { readonly signal?: AbortSignal }
  ) => Promise<unknown>;
  readonly signalSource: FakeSignalSource;
}): Promise<number> {
  const command = runExtractionFillCommand as unknown as (
    opts: ParsedFlags,
    dependencies: typeof deps
  ) => Promise<number>;
  return command({
    variant: "longmemeval_oracle",
    extractionAuthority: "/fixture/extraction-authority.json"
  } as ParsedFlags, deps);
}

function completedFillResult() {
  return {
    requestedTurns: 0,
    cacheHits: 0,
    newlyExtracted: 0,
    coverage: 1,
    retrySuccesses: 0,
    rateLimitRetries: 0,
    adaptiveConcurrencyBackoffs: 0,
    adaptiveConcurrencyBackoffMs: 0,
    terminalRetryClassifications: emptyBenchTerminalRetryClassifications(),
    manifest: {}
  };
}
