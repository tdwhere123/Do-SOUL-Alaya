import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertNewApiDeepSeek500Authorization,
  assertNewApiDeepSeek500RootBinding,
  createFreshNewApiDeepSeek500Authorization,
  discardFreshNewApiDeepSeek500Authorization
} from "../../../../longmemeval/extraction/authority/direct-deepseek-500.js";
import {
  createExtractionAuthorityReceipt,
  type ExtractionAuthorityObservation
} from
  "../../../../longmemeval/extraction/authority/receipt.js";
import { createExtractionExecutionAuthority } from
  "../../../../longmemeval/extraction/fill/execution-authority.js";
import { acquireExtractionCacheWriteLease } from
  "../../../../longmemeval/extraction/fill/manifest/fill-root-guard.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

it("binds a fresh NewAPI 500Q root to the advertised non-thinking model identity", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  const authorization = createFreshNewApiDeepSeek500Authorization({
    cacheRoot,
    operator: "local-operator"
  });

  expect(() => assertNewApiDeepSeek500Authorization({
    action: "fill",
    authorization,
    observation: newApiObservation()
  })).not.toThrow();
  expect(() => assertNewApiDeepSeek500RootBinding({ authorization, cacheRoot })).not.toThrow();
});

it("rejects a stale lower-case model identity and compatible payload profile", () => {
  const parent = createTemporaryRoot();
  const authorization = createFreshNewApiDeepSeek500Authorization({
    cacheRoot: join(parent, "cache"),
    operator: "local-operator"
  });

  expect(() => assertNewApiDeepSeek500Authorization({
    action: "fill",
    authorization,
    observation: { ...newApiObservation(), extraction: {
      ...newApiObservation().extraction,
      model: "deepseek-v4-flash"
    } }
  })).toThrow(/wrong extraction scope/u);
  expect(() => assertNewApiDeepSeek500Authorization({
    action: "fill",
    authorization,
    observation: { ...newApiObservation(), extraction: {
      ...newApiObservation().extraction,
      requestProfile: "provider-default-v1"
    } }
  })).toThrow(/wrong extraction scope/u);
});

it("rejects a replacement root even when its original marker is moved into place", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  const authorization = createFreshNewApiDeepSeek500Authorization({
    cacheRoot,
    operator: "local-operator"
  });
  const previousRoot = join(parent, "previous-cache");

  renameSync(cacheRoot, previousRoot);
  mkdirSync(cacheRoot);
  renameSync(
    join(previousRoot, ".alaya-direct-newapi-deepseek-500-root.json"),
    join(cacheRoot, ".alaya-direct-newapi-deepseek-500-root.json")
  );

  expect(() => assertNewApiDeepSeek500RootBinding({ authorization, cacheRoot }))
    .toThrow(/target root changed/u);
});

it("permits inode drift only with the root's active writer lease", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  const authorization = createFreshNewApiDeepSeek500Authorization({
    cacheRoot,
    operator: "local-operator"
  });
  const driftedAuthorization = { ...authorization, cache_root_inode: "0" };

  expect(() => assertNewApiDeepSeek500RootBinding({
    authorization: driftedAuthorization,
    cacheRoot
  })).toThrow(/target root changed/u);
  const lease = acquireExtractionCacheWriteLease(cacheRoot);
  try {
    expect(() => assertNewApiDeepSeek500RootBinding({
      authorization: driftedAuthorization,
      cacheRoot,
      writeLease: lease
    })).not.toThrow();
    expect(() => assertNewApiDeepSeek500RootBinding({
      authorization: { ...driftedAuthorization, cache_root_device: "0" },
      cacheRoot,
      writeLease: lease
    })).toThrow(/target root changed/u);
  } finally {
    lease.release();
  }
});

it("uses inode drift tolerance only after a receipt-bound execution owns the root", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  const authorization = createFreshNewApiDeepSeek500Authorization({
    cacheRoot,
    operator: "local-operator"
  });
  const receipt = createExtractionAuthorityReceipt({
    action: "fill",
    observation: newApiObservation(),
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      maximumInputTokensPerAttempt: 65_536
    },
    diskFloorBytes: 0,
    inspection: availableInspection(),
    directSpend: { ...authorization, cache_root_inode: "0" },
    maxConcurrency: 1
  });

  expect(() => createExtractionExecutionAuthority(receipt, cacheRoot))
    .toThrow(/target root changed/u);
  const lease = acquireExtractionCacheWriteLease(cacheRoot);
  try {
    expect(() => createExtractionExecutionAuthority(
      receipt, cacheRoot, undefined, lease
    )).not.toThrow();
  } finally {
    lease.release();
  }
});

it("does not discard a replacement root when its old marker is moved into place", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  const authorization = createFreshNewApiDeepSeek500Authorization({
    cacheRoot,
    operator: "local-operator"
  });
  const previousRoot = join(parent, "previous-cache");

  renameSync(cacheRoot, previousRoot);
  mkdirSync(cacheRoot);
  renameSync(
    join(previousRoot, ".alaya-direct-newapi-deepseek-500-root.json"),
    join(cacheRoot, ".alaya-direct-newapi-deepseek-500-root.json")
  );
  discardFreshNewApiDeepSeek500Authorization({ authorization, cacheRoot });

  expect(existsSync(cacheRoot)).toBe(true);
});

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-direct-newapi-deepseek-"));
  temporaryRoots.push(root);
  return root;
}

function newApiObservation(): ExtractionAuthorityObservation {
  return {
    revision: `git-worktree-v1:${"a".repeat(40)}:${"b".repeat(64)}`,
    commandDigest: "c".repeat(64),
    selectionDigest: "d".repeat(64),
    keyDigest: "e".repeat(64),
    dataset: {
      variant: "longmemeval_s",
      revisionSha256: "f".repeat(64),
      windowOffset: 0,
      windowLimit: 500,
      expectedKeySetSha256: "e".repeat(64)
    },
    extraction: {
      model: "DeepSeek-V4-Flash",
      modelFamily: "deepseek-v4-flash-nonthinking",
      requestProfile: "deepseek-v4-nonthinking-v1",
      providerUrl: "https://example.test/v1",
      systemPromptSha256: "f".repeat(64),
      cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
      manifestSha256: null,
      rawContentClosureSha256: "e".repeat(64)
    },
    inventory: {
      expectedTurns: 72_277,
      validTurns: 0,
      missingTurns: 72_277,
      invalidTurns: 0,
      orphanTurns: 0
    }
  };
}

function availableInspection() {
  return {
    writerLock: "absent" as const,
    disk: { status: "available" as const, freeBytes: 2_048 },
    credentialStatus: "present" as const,
    modelReadiness: "not_probed" as const
  };
}
