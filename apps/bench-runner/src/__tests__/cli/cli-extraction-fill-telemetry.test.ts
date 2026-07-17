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
    cacheHits: 1,
    newlyExtracted: 1,
    retrySuccesses: 1,
    rateLimitRetries: 3,
    terminalRetryClassifications: {
      failure_max_retries: 0,
      failure_non_retryable_4xx: 0,
      failure_timeout: 0,
      failure_aborted: 0
    },
    coverage: 1,
    manifest: {}
  });

  const exitCode = await runExtractionFillCommand({
    variant: "longmemeval_oracle",
    extractionAuthority: "/authority/receipt.json"
  } as ParsedFlags);

  expect(exitCode).toBe(0);
  expect(stdout).toMatch(
    /failures=0.*retry_successes=1.*rate_limit_retries=3.*terminal_max_retries=0.*terminal_nonretryable_4xx=0.*terminal_timeouts=0/u
  );
});

it("forwards the selected cache and pinned dataset authority roots", async () => {
  mocks.runExtractionFill.mockResolvedValue({
    requestedTurns: 0,
    cacheHits: 0,
    newlyExtracted: 0,
    retrySuccesses: 0,
    rateLimitRetries: 0,
    terminalRetryClassifications: {
      failure_max_retries: 0,
      failure_non_retryable_4xx: 0,
      failure_timeout: 0,
      failure_aborted: 0
    },
    coverage: 1,
    manifest: {}
  });

  await runExtractionFillCommand({
    variant: "longmemeval_s",
    extractionCacheRoot: "/authority/cache",
    pinnedMetaRoot: "/authority/meta",
    extractionAuthority: "/authority/receipt.json"
  } as ParsedFlags);

  expect(mocks.runExtractionFill).toHaveBeenCalledWith(expect.objectContaining({
    cacheRoot: "/authority/cache",
    pinnedMetaRoot: "/authority/meta"
  }));
});
