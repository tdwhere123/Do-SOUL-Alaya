import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });
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

it("loads the expansion spend approval file before handing the fill to the runtime gate", async () => {
  const signalSource = new FakeSignalSource();
  const approval = { kind: "longmemeval_expansion_spend_approval" };
  const readExpansionSpendApproval = vi.fn(() => approval);
  const run = vi.fn(async () => completedFillResult());
  const command = runExtractionFillCommand as unknown as (
    opts: ParsedFlags,
    dependencies: {
      readonly runExtractionFill: typeof run;
      readonly signalSource: FakeSignalSource;
      readonly readExpansionSpendApproval: typeof readExpansionSpendApproval;
    }
  ) => Promise<number>;

  const exitCode = await command({
    variant: "longmemeval_oracle",
    extractionAuthority: "/fixture/extraction-authority.json",
    expansionSpendApproval: "/fixture/expansion-spend-approval.json"
  } as ParsedFlags, { runExtractionFill: run, signalSource, readExpansionSpendApproval });

  expect(exitCode).toBe(0);
  expect(readExpansionSpendApproval).toHaveBeenCalledWith("/fixture/expansion-spend-approval.json");
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ expansionSpendApproval: approval }));
});

it("fail-closes when an expansion spend path is set but the reader dep is missing", async () => {
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
    expansionSpendApproval: "/fixture/expansion-spend-approval.json"
  } as ParsedFlags, { runExtractionFill: run, signalSource });

  expect(exitCode).toBe(2);
  expect(run).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(
    expect.stringMatching(/expansion spend approval reader is unavailable/u)
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

it.each([
  ["--ingestion-mode", "lazy_field"],
  ["--semantic-artifact-root", "/unused-retired-overlay"],
  ["--semantic-max-calls", "0"],
  ["--semantic-max-failures", "0"]
])("refuses %s before dispatch, signal subscriptions or dry-preflight key reads", async (flag, value) => {
  const peeled = peelExtractionFillLazyFlags(["--variant", "s", flag, value]);
  const signalSource = new FakeSignalSource();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const run = vi.fn(async () => completedFillResult());
  for (const extra of [[], ["--extraction-open-semantics", "--extraction-source-packing", "complete-source",
    "--extraction-cache-root", "/absent-cache", "--extraction-preflight-out", "/unwritable-report.json",
    "--extraction-preflight-keys", "/absent-keys.json"]]) {
    const parsed = parseFlags([...peeled.rest, ...extra]);
    expect(await runExtractionFillCommand(parsed, { runExtractionFill: run, signalSource }, peeled.lazy)).toBe(2);
    expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining("passive semantic overlays are retired"));
  }
  expect(run).not.toHaveBeenCalled();
  expect(stdout).not.toHaveBeenCalled();
  expect(signalSource.listenerCount()).toBe(0);
});

it("continues forwarding explicit precomputed_full to the current producer", async () => {
  const peeled = peelExtractionFillLazyFlags(["--variant", "s", "--ingestion-mode", "precomputed_full"]);
  const run = vi.fn(async () => completedFillResult());
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  expect(await runExtractionFillCommand(parseFlags(peeled.rest),
    { runExtractionFill: run, signalSource: new FakeSignalSource() }, peeled.lazy)).toBe(0);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ ingestionMode: "precomputed_full" }));
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

it("accepts a finite Step source preflight cap and rejects unsupported command combinations", async () => {
  expect(parseFlags(["--extraction-preflight-output-token-cap", "16384"])
    .extractionPreflightOutputTokenCap).toBe(16384);
  for (const value of ["0", "-1", "1.5", "Infinity", String(Number.MAX_SAFE_INTEGER + 1)]) {
    expect(() => parseFlags(["--extraction-preflight-output-token-cap", value])).toThrow();
  }
  expect(() => parseFlags(["--extraction-preflight-output-token-cap"])).toThrow(/requires a value/u);
  expect(() => parseFlags(["--extraction-preflight-output-token-cap", "16384",
    "--extraction-preflight-output-token-cap", "4096"])).toThrow(/only once/u);
  const run = vi.fn(async () => completedFillResult());
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const deps = { runExtractionFill: run as never, signalSource: new FakeSignalSource() };
  for (const flags of [
    { extractionPreflightOutputTokenCap: 16384 },
    { extractionPreflightOutputTokenCap: 16384, extractionPreflightOut: "/tmp/report.json" },
    { extractionPreflightOutputTokenCap: 16384, extractionPreflightOut: "/tmp/report.json",
      extractionOpenSemantics: true, extractionSourcePacking: "reference-eight" as const }
  ]) {
    expect(await runExtractionFillCommand({ variant: "longmemeval_s", ...flags } as ParsedFlags, deps)).toBe(2);
  }
  expect(run).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/Step source output cap requires/u));
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
    retryTelemetryScope: { kind: "invocation" },
    adaptiveBackoffScope: "invocation",
    retrySuccesses: 0,
    rateLimitRetries: 0,
    adaptiveConcurrencyBackoffs: 0,
    adaptiveConcurrencyBackoffMs: 0,
    terminalRetryClassifications: emptyBenchTerminalRetryClassifications(),
    manifest: {}
  };
}
