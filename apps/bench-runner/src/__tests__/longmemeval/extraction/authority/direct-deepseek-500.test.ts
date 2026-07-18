import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

const markerWriteFailure = vi.hoisted(() => ({ enabled: false, writeContent: false }));
const rootStatFailure = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const path = await import("node:path");
  const actualLstatSync = actual.lstatSync;
  const actualWriteFileSync = actual.writeFileSync;
  return {
    ...actual,
    lstatSync(...args: Parameters<typeof actualLstatSync>) {
      if (rootStatFailure.path === String(args[0])) {
        throw new Error("simulated root stat failure");
      }
      return actualLstatSync(...args);
    },
    writeFileSync(...args: Parameters<typeof actualWriteFileSync>) {
      if (markerWriteFailure.enabled &&
          String(args[0]).endsWith(".alaya-direct-deepseek-500-root.json")) {
        if (markerWriteFailure.writeContent) {
          actualWriteFileSync(path.join(path.dirname(String(args[0])), "content.json"), "{}\n", "utf8");
        }
        throw new Error("simulated marker write failure");
      }
      return actualWriteFileSync(...args);
    }
  };
});
import {
  assertDirectDeepSeek500Authorization,
  assertDirectDeepSeek500RootBinding,
  createFreshDirectDeepSeek500Authorization,
  discardFreshDirectDeepSeek500Authorization
} from "../../../../longmemeval/extraction/authority/direct-deepseek-500.js";
import {
  createExtractionAuthorityReceipt,
  type ExtractionAuthorityObservation
} from
  "../../../../longmemeval/extraction/authority/receipt.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  markerWriteFailure.enabled = false;
  markerWriteFailure.writeContent = false;
  rootStatFailure.path = undefined;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

it("creates and binds an empty, DeepSeek-only 500Q target root", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  const authorization = createFreshDirectDeepSeek500Authorization({
    cacheRoot,
    operator: "local-operator"
  });

  expect(() => assertDirectDeepSeek500Authorization({
    action: "fill",
    authorization,
    observation: directObservation()
  })).not.toThrow();
  expect(authorization.requests_per_minute).toBe(30);
  expect(() => assertDirectDeepSeek500RootBinding({ authorization, cacheRoot })).not.toThrow();
  rmSync(cacheRoot, { force: true, recursive: true });
  mkdirSync(cacheRoot);
  expect(() => assertDirectDeepSeek500RootBinding({ authorization, cacheRoot }))
    .toThrow(/target root changed/u);
  expect(() => createFreshDirectDeepSeek500Authorization({
    cacheRoot,
    operator: "local-operator"
  })).toThrow(/must be new/u);
});

it("rejects every non-fresh or non-DeepSeek direct scope", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  const authorization = createFreshDirectDeepSeek500Authorization({
    cacheRoot,
    operator: "local-operator"
  });

  expect(() => assertDirectDeepSeek500Authorization({
    action: "probe",
    authorization,
    observation: directObservation()
  })).toThrow(/wrong extraction scope/u);
  expect(() => assertDirectDeepSeek500Authorization({
    action: "fill",
    authorization,
    observation: {
      ...directObservation(),
      extraction: { ...directObservation().extraction, model: "gpt-5.4-mini" }
    }
  })).toThrow(/wrong extraction scope/u);
});

it("accepts the non-thinking profile and rejects the compatible payload profile", () => {
  const parent = createTemporaryRoot();
  const authorization = createFreshDirectDeepSeek500Authorization({
    cacheRoot: join(parent, "cache"),
    operator: "local-operator"
  });

  expect(() => assertDirectDeepSeek500Authorization({
    action: "fill",
    authorization,
    observation: directObservation()
  })).not.toThrow();
  expect(() => assertDirectDeepSeek500Authorization({
    action: "fill",
    authorization,
    observation: compatibleObservation()
  })).toThrow(/wrong extraction scope/u);
});

it("keeps the direct authority within the standard concurrency envelope", () => {
  const parent = createTemporaryRoot();
  const authorization = createFreshDirectDeepSeek500Authorization({
    cacheRoot: join(parent, "cache"),
    operator: "local-operator"
  });
  const receipt = createExtractionAuthorityReceipt({
    action: "fill",
    observation: directObservation(),
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 300
    },
    diskFloorBytes: 1_024,
    inspection: availableInspection(),
    directSpend: authorization,
    maxConcurrency: 32
  });

  expect(receipt.limits.max_concurrency).toBe(32);
  expect(receipt.direct_spend).toEqual(authorization);
  expect(() => createExtractionAuthorityReceipt({
    action: "fill",
    observation: directObservation(),
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 300
    },
    diskFloorBytes: 1_024,
    inspection: availableInspection(),
    directSpend: authorization,
    maxConcurrency: 33
  })).toThrow(/1-32/u);
  expect(() => createExtractionAuthorityReceipt({
    action: "fill",
    observation: standardObservation(),
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 300
    },
    diskFloorBytes: 1_024,
    inspection: availableInspection(),
    maxConcurrency: 33
  })).toThrow(/1-32/u);
});

it("retires only an unchanged empty direct target after failed authorization", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  const authorization = createFreshDirectDeepSeek500Authorization({
    cacheRoot,
    operator: "local-operator"
  });

  discardFreshDirectDeepSeek500Authorization({ authorization, cacheRoot });
  expect(existsSync(cacheRoot)).toBe(false);

  const retainedRoot = join(parent, "retained-cache");
  const retained = createFreshDirectDeepSeek500Authorization({
    cacheRoot: retainedRoot,
    operator: "local-operator"
  });
  writeFileSync(join(retainedRoot, "content.json"), "{}\n", "utf8");
  discardFreshDirectDeepSeek500Authorization({ authorization: retained, cacheRoot: retainedRoot });
  expect(existsSync(retainedRoot)).toBe(true);
  expect(existsSync(join(retainedRoot, ".alaya-direct-deepseek-500-root.json"))).toBe(true);
});

it("removes an empty fresh root when marker creation fails", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  markerWriteFailure.enabled = true;

  expect(() => createFreshDirectDeepSeek500Authorization({
    cacheRoot,
    operator: "local-operator"
  })).toThrow(/simulated marker write failure/u);
  expect(existsSync(cacheRoot)).toBe(false);
});

it("retains a fresh root when marker creation races with content", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  markerWriteFailure.enabled = true;
  markerWriteFailure.writeContent = true;

  expect(() => createFreshDirectDeepSeek500Authorization({
    cacheRoot,
    operator: "local-operator"
  })).toThrow(/simulated marker write failure/u);
  expect(existsSync(join(cacheRoot, "content.json"))).toBe(true);
});

it("removes an empty fresh root when root inspection fails", () => {
  const parent = createTemporaryRoot();
  const cacheRoot = join(parent, "cache");
  rootStatFailure.path = cacheRoot;

  expect(() => createFreshDirectDeepSeek500Authorization({
    cacheRoot,
    operator: "local-operator"
  })).toThrow(/simulated root stat failure/u);
  expect(existsSync(cacheRoot)).toBe(false);
});

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-direct-deepseek-"));
  temporaryRoots.push(root);
  return root;
}

function directObservation(): ExtractionAuthorityObservation {
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
      model: "deepseek-v4-flash",
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

function compatibleObservation(): ExtractionAuthorityObservation {
  return {
    ...directObservation(),
    extraction: {
      ...directObservation().extraction,
      modelFamily: "deepseek-v4-flash-compatible",
      requestProfile: "provider-default-v1"
    }
  };
}

function standardObservation(): ExtractionAuthorityObservation {
  return {
    ...directObservation(),
    extraction: {
      ...directObservation().extraction,
      model: "gpt-5.4-mini",
      modelFamily: "gpt-5.4-mini",
      requestProfile: "provider-default-v1",
      providerUrl: "https://example.test/v1"
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
