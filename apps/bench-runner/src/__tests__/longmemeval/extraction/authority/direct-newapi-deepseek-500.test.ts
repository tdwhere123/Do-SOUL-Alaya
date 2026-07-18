import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertNewApiDeepSeek500Authorization,
  assertNewApiDeepSeek500RootBinding,
  createFreshNewApiDeepSeek500Authorization
} from "../../../../longmemeval/extraction/authority/direct-deepseek-500.js";
import type { ExtractionAuthorityObservation } from
  "../../../../longmemeval/extraction/authority/receipt.js";

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
