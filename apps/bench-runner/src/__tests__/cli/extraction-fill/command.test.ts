import { afterEach, expect, it, vi } from "vitest";
import type { ParsedFlags } from "../../../cli/cli-options.js";

const mocks = vi.hoisted(() => ({
  fallbackRun: vi.fn(async () => {
    throw new Error("signal dependency injection missing");
  })
}));

vi.mock("../../../longmemeval/extraction-fill.js", () => ({
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
  return command({ variant: "longmemeval_oracle" } as ParsedFlags, deps);
}
