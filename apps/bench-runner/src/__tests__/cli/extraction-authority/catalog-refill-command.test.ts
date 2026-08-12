import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runAuthorizeExtractionCommand } from
  "../../../cli/extraction-authority/command.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

it("embeds an audited existing-root missing-key set bound to target selection", async () => {
  const cacheRoot = temporaryRoot();
  const allowlistPath = join(cacheRoot, "allowlist.json");
  writeFileSync(allowlistPath, JSON.stringify({
    kind: "test-catalog-refill",
    expected_turns: 2,
    cached_turns: 1,
    missing_turns: 1,
    expected_key_set_sha256: "d".repeat(64),
    cache_keys: ["2".repeat(64)]
  }), "utf8");
  const write = vi.fn();

  const exitCode = await runAuthorizeExtractionCommand([
    "--variant", "s",
    "--offset", "0",
    "--limit", "100",
    "--extraction-cache-root", cacheRoot,
    "--catalog-refill-allowlist", allowlistPath,
    "--extraction-target-selection", join(cacheRoot, "target-selection.json"),
    "--extraction-action", "fill",
    "--extraction-receipt-out", join(cacheRoot, "authority.json"),
    "--extraction-output-token-cap", "512",
    "--extraction-output-token-field", "max_tokens",
    "--extraction-input-price-usd-per-million", "1",
    "--extraction-output-price-usd-per-million", "2",
    "--extraction-max-input-tokens", "300",
    "--extraction-disk-floor-bytes", "0"
  ], {
    inspect: vi.fn(async () => inspection()),
    write,
    readRevision: () => "a".repeat(40),
    readLedger: () => undefined,
    readTargetSelection: () => ({ receipt_digest: "9".repeat(64) } as never),
    assertTargetSelection: () => undefined,
    assertTargetSelectionWindow: () => undefined
  });

  expect(exitCode).toBe(0);
  expect(write).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    action: "fill",
    limits: expect.objectContaining({
      starting_missing: 1,
      maximum_attempts: 5,
      successful_shard_ceiling: 1
    }),
    catalog_refill: expect.objectContaining({
      shard_count: 1,
      keys: ["2".repeat(64)]
    }),
    target_selection_digest: "9".repeat(64)
  }));
});

function inspection() {
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
        cacheKeyAlgorithm: "test",
        manifestSha256: "a".repeat(64),
        rawContentClosureSha256: "b".repeat(64)
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
    invalidShards: [],
    preservedValidClosure: {
      shard_count: 1,
      key_set_sha256: "c".repeat(64),
      content_closure_sha256: "d".repeat(64)
    },
    writerLock: "absent" as const,
    disk: { status: "available" as const, freeBytes: 10_000 },
    credentialStatus: "present" as const,
    modelReadiness: "not_probed" as const
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-catalog-refill-command-"));
  roots.push(root);
  return root;
}
