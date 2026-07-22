import { afterEach, expect, it, vi } from "vitest";
import type { ParsedFlags } from "../../../cli/cli-options.js";

const mocks = vi.hoisted(() => ({
  fallbackRun: vi.fn(async () => {
    throw new Error("signal dependency injection missing");
  })
}));

vi.mock("../../../longmemeval/extraction/extraction-fill.js", () => ({
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
    terminalRetryClassifications: {
      failure_max_retries: 0,
      failure_non_retryable_4xx: 0,
      failure_timeout: 0,
      failure_aborted: 0
    },
    manifest: {}
  };
}
