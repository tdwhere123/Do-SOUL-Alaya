import { afterEach, expect, it, vi } from "vitest";
import {
  runAuthorizeExtractionCommand
} from "../../../cli/extraction-authority/command.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("writes an inspect-only, digest-bound authority receipt without invoking extraction", async () => {
  const inspect = vi.fn(async () => ({
    observation: {
      revision: "a".repeat(40),
      commandDigest: "b".repeat(64),
      selectionDigest: "c".repeat(64),
      keyDigest: "d".repeat(64),
      dataset: {
        variant: "longmemeval_s",
        revisionSha256: "e".repeat(64),
        windowOffset: 0,
        windowLimit: 100,
        expectedKeySetSha256: "d".repeat(64)
      },
      extraction: {
        model: "gpt-5.4-mini",
        modelFamily: "gpt-5.4-mini",
        requestProfile: "provider-default-v1" as const,
        providerUrl: "https://example.test/v1",
        systemPromptSha256: "f".repeat(64),
        cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
        manifestSha256: null,
        rawContentClosureSha256: null
      },
      inventory: {
        expectedTurns: 2,
        validTurns: 0,
        missingTurns: 2,
        invalidTurns: 0,
        orphanTurns: 0
      }
    },
    missingKeys: ["1".repeat(64), "2".repeat(64)],
    writerLock: "absent" as const,
    disk: { status: "available" as const, freeBytes: 10_000 },
    credentialStatus: "present" as const,
    modelReadiness: "not_probed" as const
  }));
  const write = vi.fn();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const exitCode = await runAuthorizeExtractionCommand([
    "--variant", "s",
    "--extraction-action", "fill",
    "--extraction-receipt-out", "/tmp/authority.json",
    "--extraction-output-token-cap", "512",
    "--extraction-output-token-field", "max_tokens",
    "--extraction-input-price-usd-per-million", "1",
    "--extraction-output-price-usd-per-million", "2",
    "--extraction-max-input-tokens", "300",
    "--extraction-disk-floor-bytes", "1024"
  ], {
    inspect,
    write,
    readRevision: () => "a".repeat(40),
    readLedger: () => undefined
  });

  expect(exitCode).toBe(0);
  expect(inspect).toHaveBeenCalledOnce();
  expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ action: "fill" }));
  expect(write).toHaveBeenCalledOnce();
  expect(write.mock.calls[0]?.[1]).toMatchObject({
    action: "fill",
    identity_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    receipt_digest: expect.stringMatching(/^[a-f0-9]{64}$/u)
  });
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("attempt_cap=3"));
});

it("carries an existing fill lineage cap while inspecting its completed shards out of closure", async () => {
  const first = authorityInspection("a".repeat(64));
  const second = authorityInspection("b".repeat(64));
  const inspect = vi.fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);
  const write = vi.fn();
  const ledger = {
    lineageDigest: "f".repeat(64),
    startingMissing: 2,
    maximumAttempts: 3,
    successfulShardCeiling: 2,
    attempts: 1,
    successfulShards: 1,
    successfulKeys: ["1".repeat(64)],
    pendingKeys: [],
    telemetry: {
      retrySuccesses: 0,
      rateLimitRetries: 0,
      terminalRetryClassifications: {
        failure_max_retries: 0,
        failure_non_retryable_4xx: 0,
        failure_timeout: 0,
        failure_aborted: 0
      },
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usageUnavailableRequests: 0,
      unresolvedTransportAttempts: 0,
      usageUnknownAttempts: 0
    }
  };

  const exitCode = await runAuthorizeExtractionCommand(authorizeArgs(), {
    inspect,
    write,
    readRevision: () => "a".repeat(40),
    readLedger: () => ledger
  });

  expect(exitCode).toBe(0);
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(inspect.mock.calls[1]?.[0]).toMatchObject({
    action: "fill",
    excludeContentClosureKeys: ["1".repeat(64)]
  });
  expect(write.mock.calls[0]?.[1]).toMatchObject({
    limits: {
      starting_missing: 2,
      maximum_attempts: 3,
      successful_shard_ceiling: 2
    },
    observation: {
      extraction: { rawContentClosureSha256: "b".repeat(64) }
    }
  });
});

function authorizeArgs(): string[] {
  return [
    "--variant", "s",
    "--extraction-action", "fill",
    "--extraction-receipt-out", "/tmp/authority.json",
    "--extraction-output-token-cap", "512",
    "--extraction-output-token-field", "max_tokens",
    "--extraction-input-price-usd-per-million", "1",
    "--extraction-output-price-usd-per-million", "2",
    "--extraction-max-input-tokens", "300",
    "--extraction-disk-floor-bytes", "1024"
  ];
}

function authorityInspection(rawContentClosureSha256: string) {
  return {
    observation: {
      revision: "a".repeat(40),
      commandDigest: "b".repeat(64),
      selectionDigest: "c".repeat(64),
      keyDigest: "d".repeat(64),
      dataset: {
        variant: "longmemeval_s",
        revisionSha256: "e".repeat(64),
        windowOffset: 0,
        windowLimit: 100,
        expectedKeySetSha256: "d".repeat(64)
      },
      extraction: {
        model: "gpt-5.4-mini",
        modelFamily: "gpt-5.4-mini",
        requestProfile: "provider-default-v1" as const,
        providerUrl: "https://example.test/v1",
        systemPromptSha256: "f".repeat(64),
        cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
        manifestSha256: null,
        rawContentClosureSha256
      },
      inventory: {
        expectedTurns: 2,
        validTurns: 1,
        missingTurns: 1,
        invalidTurns: 0,
        orphanTurns: 0
      }
    },
    missingKeys: ["2".repeat(64)],
    writerLock: "absent" as const,
    disk: { status: "available" as const, freeBytes: 10_000 },
    credentialStatus: "present" as const,
    modelReadiness: "not_probed" as const
  };
}
