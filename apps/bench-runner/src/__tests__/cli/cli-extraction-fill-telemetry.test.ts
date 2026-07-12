import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ParsedFlags } from "../../cli/cli-options.js";

const mocks = vi.hoisted(() => ({ runExtractionFill: vi.fn() }));

vi.mock("../../longmemeval/extraction-fill.js", () => ({
  runExtractionFill: mocks.runExtractionFill
}));

import { runExtractionFillCommand } from "../../cli/cli-commands.js";

let originalWrite: typeof process.stdout.write;
let stdout: string;

beforeEach(() => {
  stdout = "";
  originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
  vi.clearAllMocks();
});

it("prints extraction retry telemetry in the CLI done line", async () => {
  mocks.runExtractionFill.mockResolvedValue({
    requestedTurns: 2,
    cacheHits: 0,
    newlyExtracted: 1,
    failures: 1,
    retrySuccesses: 1,
    rateLimitRetries: 3,
    terminalRetryClassifications: {
      failure_max_retries: 1,
      failure_non_retryable_4xx: 0,
      failure_timeout: 0,
      failure_aborted: 0
    },
    coverage: 0.5,
    manifest: {}
  });

  const exitCode = await runExtractionFillCommand({
    variant: "longmemeval_oracle"
  } as ParsedFlags);

  expect(exitCode).toBe(1);
  expect(stdout).toMatch(
    /retry_successes=1.*rate_limit_retries=3.*terminal_max_retries=1.*terminal_nonretryable_4xx=0.*terminal_timeouts=0/u
  );
});
