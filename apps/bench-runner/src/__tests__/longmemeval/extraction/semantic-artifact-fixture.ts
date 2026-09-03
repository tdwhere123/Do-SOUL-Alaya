import { createHash } from "node:crypto";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  planOfficialApiSemanticWorkset,
  transportPackIdentity
} from "@do-soul/alaya-soul";
import { computeExtractionKeySetSha256 } from
  "../../../runs/extraction/content-closure.js";
import type { SemanticArtifactUnsigned } from
  "../../../runs/extraction/cache/semantic-artifact/contract.js";
import type { SemanticFillTask } from
  "../../../runs/extraction/fill/semantic-fill-executor.js";
import { computeSemanticSourceCorpusCacheKeys } from
  "../../../runs/extraction/fill/semantic-fill-authority.js";
import {
  currentSemanticReplayAuthority,
  semanticReplayIdentityDigest,
  unwrapSemanticReplayAuthority
} from "../../../runs/extraction/cache/semantic-artifact/replay-authority.js";

export const SEMANTIC_CAPABILITY = "official_api_signals:v1";
export const SEMANTIC_FIXTURE_DATASET_REVISION = "dd".repeat(32);
export const SEMANTIC_RAW = '{"signals":[{}]}';
export const SEMANTIC_RAW_SHA256 = createHash("sha256")
  .update(SEMANTIC_RAW, "utf8").digest("hex");

export function semanticTask(
  text = "I moved to Berlin.",
  overrides: Partial<SemanticFillTask> = {}
): SemanticFillTask {
  const unit = planOfficialApiSemanticWorkset(
    text, [{ role: "user", content: text }], SEMANTIC_FIXTURE_DATASET_REVISION
  ).units[0];
  if (unit === undefined) throw new Error("semantic fixture text produced no work unit");
  return {
    ...unit,
    capability: SEMANTIC_CAPABILITY,
    semanticContract: unit.semanticIdentity.contractId,
    modelFamily: "mimo-v2.5",
    modelId: "mimo-v2.5",
    transportModelId: "mimo-v2.5",
    requestProfile: "mimo-v2.5-nonthinking-v1",
    providerUrlSha256: "44".repeat(32),
    sourceAuthority: semanticFixtureSourceAuthority(unit.sourceCorpus),
    ...overrides
  };
}

export function semanticTasks(texts: readonly string[]): readonly SemanticFillTask[] {
  const source = texts.join(" ");
  return planOfficialApiSemanticWorkset(
    source, [{ role: "user", content: source }], SEMANTIC_FIXTURE_DATASET_REVISION
  ).units.map(
    (unit) => ({
      ...unit,
      capability: SEMANTIC_CAPABILITY,
      semanticContract: unit.semanticIdentity.contractId,
      modelFamily: "mimo-v2.5",
      modelId: "mimo-v2.5",
      transportModelId: "mimo-v2.5",
      requestProfile: "mimo-v2.5-nonthinking-v1",
      providerUrlSha256: "44".repeat(32),
      sourceAuthority: semanticFixtureSourceAuthority(unit.sourceCorpus)
    })
  );
}

export function semanticFixtureSourceAuthority(
  sourceCorpus: string,
  overrides: Partial<SemanticFillTask["sourceAuthority"]> = {}
): SemanticFillTask["sourceAuthority"] {
  const base = {
    schemaVersion: 3 as const,
    manifestSha256: "11".repeat(32),
    dataset: "longmemeval-s",
    datasetRevision: SEMANTIC_FIXTURE_DATASET_REVISION,
    extractionModel: "mimo-v2.5",
    modelFamily: "mimo-v2.5",
    requestProfile: "mimo-v2.5-nonthinking-v1",
    systemPromptSha256: createHash("sha256")
      .update(OFFICIAL_API_SYSTEM_PROMPT, "utf8").digest("hex"),
    cacheKeyAlgorithm: "fixture-cache-key-v1",
    expectedTurns: 0,
    expectedKeySetSha256: "00".repeat(32),
    contentClosureSha256: "33".repeat(32),
    contentClosureIndexSha256: "00".repeat(32),
    windowOffset: 0,
    windowLimit: 1
  };
  const substrateCacheKeys = computeSemanticSourceCorpusCacheKeys(sourceCorpus, base);
  const contentClosureIndex = Object.fromEntries(substrateCacheKeys.map(
    (cacheKey) => [cacheKey, ["aa".repeat(32), 0, 0]]
  ));
  return {
    datasetRevision: SEMANTIC_FIXTURE_DATASET_REVISION,
    substrateCacheKeys,
    substrateManifest: {
      ...base,
      expectedTurns: substrateCacheKeys.length,
      expectedKeySetSha256: computeExtractionKeySetSha256(substrateCacheKeys),
      contentClosureIndexSha256: createHash("sha256")
        .update(JSON.stringify(contentClosureIndex), "utf8").digest("hex")
    },
    ...overrides
  };
}

export function semanticArtifactUnsigned(
  task: SemanticFillTask,
  overrides: Partial<SemanticArtifactUnsigned> = {}
): SemanticArtifactUnsigned {
  const replayIdentity = unwrapSemanticReplayAuthority(currentSemanticReplayAuthority());
  const replayIdentityDigest = semanticReplayIdentityDigest(replayIdentity);
  return {
    schema_version: 1,
    kind: "assertion_semantic_artifact_v1",
    semantic_key: task.semanticKey,
    semantic_contract: task.semanticContract,
    capability: task.capability,
    capability_set: [task.capability],
    model_family: task.modelFamily,
    model_id: task.modelId,
    admission_state: "provider_backed",
    source_bindings: [task.binding],
    replay_identity: replayIdentity,
    replay_identity_digest: replayIdentityDigest,
    raw_response_digest: SEMANTIC_RAW_SHA256,
    raw_evidence_binding: {
      pack_identity: transportPackIdentity("token_aware", [task.semanticKey]),
      request_sha256: "88".repeat(32),
      source_corpus_identity: task.binding.sourceCorpusIdentity,
      replay_identity_digest: replayIdentityDigest,
      policy_kind: "token_aware",
      member_semantic_keys: [task.semanticKey]
    },
    provider_provenance: {
      provider_url_sha256: task.providerUrlSha256,
      request_profile: task.requestProfile,
      model_id: task.modelId,
      transport_model_id: task.transportModelId
    },
    ...overrides
  };
}

export const TOKEN_AWARE_POLICY = Object.freeze({
  kind: "token_aware" as const,
  maxAssertions: 32,
  maxInputTokens: 100_000,
  expectedOutputCap: 8_000,
  systemPromptChars: 100
});
