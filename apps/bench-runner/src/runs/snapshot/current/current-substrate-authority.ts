import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isCacheOnlySeedExtractionPath, type SeedExtractionPath } from
  "@do-soul/alaya-eval";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { resolveCompileSeedExtractionConfig } from
  "../../compile-seed/compile-seed-config.js";
import { preflightExtractionCache } from "../../compile-seed/compile-seed-preflight.js";
import type { LongMemEvalQuestion, LongMemEvalVariant } from "../../../datasets/longmemeval/ingestion/dataset.js";
import {
  readExtractionCacheManifestIdentity
} from "../../extraction/cache/extraction-cache-manifest.js";
import { hasCompleteExtractionFillAuthority, hasCompleteExtractionFillSummary } from
  "../../extraction/fill/fill-authority.js";
import type { ExtractionFillQuestionWindow } from
  "../../extraction/fill/manifest/fill-manifest-contract.js";
import type { LongMemEvalExtractionTurn } from "../../extraction/turn-contents.js";
import { loadDatasetWithIdentity } from "../../../datasets/longmemeval/ingestion/fetch.js";
import {
  isLongMemEvalRunProvenanceGateEligible,
  type LongMemEvalRunProvenance
} from "../../provenance/run.js";
import {
  snapshotManifestPath,
  snapshotQuestionIdDigest,
  type LongMemEvalSnapshotManifest,
  type LongMemEvalSnapshotSidecarFile,
  type SnapshotExtractionProvenanceV3
} from "../materialize.js";
import { deriveSnapshotAttribution } from "../attribution.js";
import { verifySnapshotArtifactIntegrity } from "../integrity.js";
import {
  buildSnapshotMeasurementOracle,
  type SnapshotMeasurementOracleAccessor
} from "../measurement-oracle.js";
import { assertSnapshotSeedLedgerBinding } from "../seed-ledger/seed-ledger-binding.js";
import { assertSnapshotDatasetSubstrateIdentity } from
  "../substrate-binding.js";
import { assertCurrentSnapshotAttributionClaim } from "./current-attribution.js";
import {
  assertSnapshotExtractionAuthorityBinding,
  buildSnapshotExtractionSummary,
  type SnapshotExtractionAuthority
} from "../extraction-authority.js";
import {
  bindSnapshotRunProvenanceAuthority,
  compactSnapshotRunProvenance,
  isSnapshotRunProvenanceSummaryGateEligible
} from "../run-provenance.js";
import type { SourceAssertionSupplementBinding } from
  "../../extraction/cache/semantic-supplement/source-assertion-supplement.js";
import type { ExtractionCachePreflightProof } from
  "../../compile-seed/compile-seed-types.js";
import {
  assertExtractionCachePreflightProofManifest,
  assertExtractionCachePreflightProofReuse,
  createExtractionCachePreflightProof
} from "../../compile-seed/preflight/cache-preflight-proof.js";
import {
  assertDiagnosticManifestConsumeAuthority,
  assertDiagnosticSnapshotConsumeAuthority
} from "./diagnostic-consume-authority.js";
import {
  assertDiagnosticSnapshotWriteAuthority,
  type SnapshotConsumeAuthority,
  type SnapshotWriteAuthority
} from "./diagnostic-write-authority.js";

const currentPostFillProofRoots = new WeakMap<
  ExtractionCachePreflightProof,
  string
>();

export function assertCacheOnlyEnvironment(
  env: Readonly<Record<string, string | undefined>>
): void {
  const live = env.ALAYA_BENCH_ALLOW_LIVE_EXTRACTION?.trim().toLowerCase();
  const credential = env.ALAYA_OFFICIAL_GARDEN_SECRET_REF?.trim() ||
    env.ALAYA_OFFICIAL_GARDEN_API_KEY?.trim() ||
    env.OFFICIAL_API_GARDEN_API_KEY?.trim() ||
    env.ALAYA_GARDEN_OPENAI_SECRET_REF?.trim() ||
    env.ALAYA_QA_API_KEY?.trim();
  const conflictCredential = env.ALAYA_CONFLICT_LLM_PROVIDER_URL?.trim() ||
    env.ALAYA_CONFLICT_LLM_API_KEY?.trim();
  if (credential || conflictCredential || live === "1" || live === "true") {
    throw new Error("post-fill benchmark stages must be credentialless and cache-only");
  }
}

export function assertCurrentPostFillCacheAuthority(input: {
  readonly cacheRoot: string;
  readonly datasetSha256: string;
  readonly requiredTurnContents: readonly string[];
  readonly requiredExtractionTurns: readonly LongMemEvalExtractionTurn[];
  readonly requiredQuestionWindow: ExtractionFillQuestionWindow;
  readonly env: Readonly<Record<string, string | undefined>>;
}): SnapshotExtractionProvenanceV3 {
  return inspectCurrentPostFillCacheAuthority(input).provenance;
}

export function createCurrentPostFillCacheAuthorityProof(
  input: Parameters<typeof assertCurrentPostFillCacheAuthority>[0]
): ExtractionCachePreflightProof {
  const inspected = inspectCurrentPostFillCacheAuthority(input);
  const proof = inspected.proof;
  currentPostFillProofRoots.set(proof, resolve(input.cacheRoot));
  return proof;
}

export function assertCurrentPostFillCacheAuthorityProof(
  input: Parameters<typeof assertCurrentPostFillCacheAuthority>[0] & {
    readonly proof: ExtractionCachePreflightProof;
  }
): void {
  const cacheRoot = currentPostFillProofRoots.get(input.proof);
  if (cacheRoot === undefined || cacheRoot !== resolve(input.cacheRoot)) {
    throw new Error("current post-fill cache authority proof is absent or forged");
  }
  assertCacheOnlyEnvironment(input.env);
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity === undefined || identity.manifest.schema_version !== 3 ||
      !hasCompleteExtractionFillAuthority(identity.manifest) ||
      identity.manifest.dataset_revision !== input.datasetSha256) {
    throw new Error("post-fill extraction manifest changed after cache preflight");
  }
  const config = resolveCompileSeedExtractionConfig({ ...input.env }, identity.manifest);
  assertExtractionCachePreflightProofReuse(input.proof, {
    cacheRoot,
    manifestIdentity: identity,
    config,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    requiredTurnContents: input.requiredTurnContents,
    requiredExtractionTurns: input.requiredExtractionTurns,
    requiredQuestionWindow: input.requiredQuestionWindow
  });
}

export function assertCurrentPostFillCacheAuthorityProofManifest(
  input: {
    readonly proof: ExtractionCachePreflightProof;
    readonly cacheRoot: string;
    readonly manifestSha256: string;
  }
): void {
  if (currentPostFillProofRoots.get(input.proof) !== resolve(input.cacheRoot)) {
    throw new Error("current post-fill cache authority proof is absent or forged");
  }
  assertExtractionCachePreflightProofManifest(input.proof, input.manifestSha256);
}

function inspectCurrentPostFillCacheAuthority(
  input: Parameters<typeof assertCurrentPostFillCacheAuthority>[0]
) {
  const identity = readExtractionCacheManifestIdentity(input.cacheRoot);
  if (identity === undefined || identity.manifest.schema_version !== 3) {
    throw new Error("post-fill benchmark requires a complete v3 extraction manifest");
  }
  if (identity.manifest.dataset_revision !== input.datasetSha256) {
    throw new Error("post-fill extraction manifest dataset identity mismatch");
  }
  const complete = hasCompleteExtractionFillAuthority(identity.manifest);
  if (!complete && identity.manifest.fill_status !== undefined) {
    throw new Error("post-fill benchmark requires a complete v3 extraction manifest");
  }
  if (complete) assertCacheOnlyEnvironment(input.env);
  const config = resolveCompileSeedExtractionConfig(
    { ...input.env },
    identity.manifest
  );
  if (!complete) assertIncompletePostFillCache(input, identity.manifest, config);
  const proof = createExtractionCachePreflightProof({
    cacheRoot: input.cacheRoot,
    manifestIdentity: identity,
    config,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    requiredTurnContents: input.requiredTurnContents,
    requiredQuestionWindow: input.requiredQuestionWindow,
    liveExtractionPossible: false,
    ...(input.requiredExtractionTurns === undefined ? {} : {
      requiredExtractionTurns: input.requiredExtractionTurns
    })
  });
  return {
    identity,
    config,
    proof,
    provenance: extractionProvenance(identity)
  };
}

function assertIncompletePostFillCache(
  input: Parameters<typeof assertCurrentPostFillCacheAuthority>[0],
  manifest: Parameters<typeof preflightExtractionCache>[0]["manifest"],
  config: ReturnType<typeof resolveCompileSeedExtractionConfig>
): never {
  preflightExtractionCache({
    cacheRoot: input.cacheRoot,
    config,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    allowLiveExtraction: false,
    liveExtractionPossible: config.apiKey !== null,
    manifest,
    requiredTurnContents: input.requiredTurnContents,
    requiredExtractionTurns: input.requiredExtractionTurns,
    requiredQuestionWindow: input.requiredQuestionWindow,
    requireManifest: true
  });
  throw new Error("post-fill benchmark requires a complete v3 extraction manifest");
}

export type { SnapshotConsumeAuthority, SnapshotWriteAuthority };

export function assertCurrentSnapshotWriteAuthority(input: {
  readonly dbPath: string;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly canonicalQuestions: readonly LongMemEvalQuestion[];
  readonly extraction: SnapshotExtractionProvenanceV3;
  readonly extractionAuthority: SnapshotExtractionAuthority;
  readonly seedExtractionPath: SeedExtractionPath;
  readonly runProvenance: LongMemEvalRunProvenance;
  readonly datasetSha256: string;
  readonly semanticSupplementBinding?: SourceAssertionSupplementBinding;
  readonly snapshotWriteAuthority?: SnapshotWriteAuthority;
}): void {
  if ((input.snapshotWriteAuthority ?? "promotion") === "diagnostic") {
    assertDiagnosticSnapshotWriteAuthority(input);
  } else {
    assertPromotionSnapshotWriteAuthority(input);
  }
  if (!isDeepStrictEqual(
    input.runProvenance.semantic_supplement,
    input.semanticSupplementBinding
  )) {
    throw new Error("snapshot semantic supplement provenance mismatch");
  }
  assertSnapshotExtractionAuthorityBinding(input.extractionAuthority, input.extraction);
  assertRunAuthorityBinding(input.runProvenance, input.extractionAuthority);
  const questions = selectCurrentExecutionQuestions(
    input.canonicalQuestions,
    input.sidecar,
    input.runProvenance
  );
  assertSnapshotSubstrate({
    dbPath: input.dbPath,
    sidecar: input.sidecar,
    questions,
    extraction: input.extraction,
    extractionAuthority: input.extractionAuthority,
    seedExtractionPath: input.seedExtractionPath,
    ...(input.semanticSupplementBinding === undefined ? {} : {
      semanticSupplementBinding: input.semanticSupplementBinding
    }),
    questionWindow: executionQuestionWindow(input.runProvenance)
  });
}

export async function verifyCurrentRecallSnapshotAuthority(input: {
  readonly snapshotDbPath: string;
  readonly variant: LongMemEvalVariant;
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly extractionAuthority: SnapshotExtractionAuthority;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly systemPrompt?: string;
  readonly snapshotConsumeAuthority?: SnapshotConsumeAuthority;
}): Promise<{
  readonly datasetSha256: string;
  readonly measurementForQuestion: SnapshotMeasurementOracleAccessor;
}> {
  const consume = input.snapshotConsumeAuthority ?? "promotion";
  assertCurrentSnapshotAttributionClaim(input.manifest, consume);
  const extraction = consume === "diagnostic"
    ? assertDiagnosticManifestConsumeAuthority(input.manifest)
    : assertCurrentManifestAuthority(input.manifest);
  if (consume === "diagnostic") {
    assertDiagnosticSnapshotConsumeAuthority({
      extraction,
      seedExtractionPath: input.manifest.seed_extraction_path,
      runProvenance: input.manifest.run_provenance!,
      datasetSha256: input.manifest.dataset_sha256!
    });
  }
  assertSnapshotExtractionAuthorityBinding(input.extractionAuthority, extraction);
  const runProvenance = bindCurrentRunProvenance(
    input.manifest,
    input.extractionAuthority,
    consume
  );
  await verifySnapshotArtifactIntegrity(
    input.snapshotDbPath,
    input.manifest.artifact_integrity!
  );
  const dataset = await loadCurrentSnapshotDataset(input);
  const questions = selectCurrentExecutionQuestions(
    dataset.questions,
    input.sidecar,
    runProvenance
  );
  assertSnapshotSubstrate({
    dbPath: input.snapshotDbPath,
    sidecar: input.sidecar,
    questions,
    extraction,
    extractionAuthority: input.extractionAuthority,
    seedExtractionPath: input.manifest.seed_extraction_path,
    ...(input.manifest.semantic_supplement_receipt === undefined ? {} : {
      semanticSupplementBinding: input.manifest.semantic_supplement_receipt
    }),
    questionWindow: executionQuestionWindow(runProvenance),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt })
  });
  return {
    datasetSha256: dataset.sha256,
    measurementForQuestion: buildSnapshotMeasurementOracle(questions, input.sidecar)
  };
}

function assertPromotionSnapshotWriteAuthority(input: {
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly extraction: SnapshotExtractionProvenanceV3;
  readonly seedExtractionPath: SeedExtractionPath;
  readonly runProvenance: LongMemEvalRunProvenance;
  readonly datasetSha256: string;
}): void {
  const questionDigest = snapshotQuestionIdDigest(input.sidecar.questions);
  const compactRunProvenance = compactSnapshotRunProvenance(input.runProvenance);
  const attribution = deriveSnapshotAttribution({
    artifactIntegrity: {
      db_sha256: "0".repeat(64),
      sidecar_sha256: "0".repeat(64),
      extraction_authority_filename: "snapshot.extraction-authority.json",
      extraction_authority_sha256: "0".repeat(64),
      extraction_authority_bytes: 1
    },
    runProvenance: compactRunProvenance,
    questionIdDigest: questionDigest,
    datasetSha256: input.datasetSha256,
    seedExtractionPath: input.seedExtractionPath,
    extractionProvenance: input.extraction
  });
  if (!isLongMemEvalRunProvenanceGateEligible(input.runProvenance) ||
      !isCacheOnlySeedExtractionPath(input.seedExtractionPath) ||
      attribution.status !== "attributed" || !attribution.gate_eligible) {
    throw new Error("snapshot writer requires gate-eligible cache-only provenance");
  }
}

function bindCurrentRunProvenance(
  manifest: LongMemEvalSnapshotManifest,
  extractionAuthority: SnapshotExtractionAuthority,
  consumeAuthority: SnapshotConsumeAuthority = "promotion"
): LongMemEvalRunProvenance {
  const runProvenance = bindSnapshotRunProvenanceAuthority(
    manifest.run_provenance!,
    extractionAuthority
  );
  if (consumeAuthority !== "diagnostic" &&
      !isLongMemEvalRunProvenanceGateEligible(runProvenance)) {
    throw new Error("current recall-eval snapshot run authority is incomplete");
  }
  if (!isDeepStrictEqual(
    manifest.semantic_supplement_receipt,
    runProvenance.semantic_supplement
  )) {
    throw new Error("snapshot semantic supplement provenance mismatch");
  }
  return runProvenance;
}

async function loadCurrentSnapshotDataset(
  input: Parameters<typeof verifyCurrentRecallSnapshotAuthority>[0]
) {
  const dataset = await loadDatasetWithIdentity(input.variant, {
    dataDir: input.dataDir,
    pinnedMetaRoot: input.pinnedMetaRoot
  });
  if (dataset.promotionAuthority === null ||
      dataset.sha256 !== input.manifest.dataset_sha256) {
    throw new Error("current snapshot requires the canonical pinned dataset authority");
  }
  return dataset;
}

function assertCurrentManifestAuthority(
  manifest: LongMemEvalSnapshotManifest
): SnapshotExtractionProvenanceV3 {
  const extraction = manifest.extraction_provenance;
  const selection = manifest.run_provenance?.selection;
  if (manifest.attribution?.status !== "attributed" ||
      manifest.attribution.gate_eligible !== true ||
      manifest.artifact_integrity === undefined ||
      manifest.dataset_sha256 === undefined || manifest.question_id_digest === undefined ||
      extraction?.schema_version !== 3 ||
      !hasCompleteExtractionFillSummary(extraction) ||
      !isCacheOnlySeedExtractionPath(manifest.seed_extraction_path) ||
      manifest.run_provenance === undefined ||
      !isSnapshotRunProvenanceSummaryGateEligible(manifest.run_provenance) ||
      selection === undefined || selection.dataset_sha256 !== manifest.dataset_sha256 ||
      selection.selected_count !== manifest.question_count ||
      selection.selected_id_digest !== manifest.question_id_digest) {
    throw new Error("current recall-eval snapshot is not gate-eligible");
  }
  return extraction;
}

export function assertStoredCurrentSnapshotAttribution(snapshotDbPath: string): void {
  const filePath = snapshotManifestPath(snapshotDbPath);
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
    attribution?: { status?: unknown; gate_eligible?: unknown };
  };
  assertCurrentSnapshotAttributionClaim(parsed);
}

function selectCurrentExecutionQuestions(
  dataset: readonly LongMemEvalQuestion[],
  sidecar: LongMemEvalSnapshotSidecarFile,
  provenance: LongMemEvalRunProvenance
): readonly LongMemEvalQuestion[] {
  const offset = provenance.execution.offset;
  const count = provenance.execution.evaluated_count;
  const expected = dataset.slice(offset, offset + count);
  if (expected.length !== count || sidecar.questions.length !== count ||
      sidecar.questions.some((question, index) =>
        question.questionId !== expected[index]?.question_id)) {
    throw new Error("snapshot questions differ from the canonical execution window");
  }
  return expected;
}

function assertSnapshotSubstrate(input: {
  readonly dbPath: string;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly questions: readonly LongMemEvalQuestion[];
  readonly extraction: SnapshotExtractionProvenanceV3;
  readonly extractionAuthority: SnapshotExtractionAuthority;
  readonly seedExtractionPath: SeedExtractionPath | undefined;
  readonly questionWindow: { readonly offset: number; readonly limit: number };
  readonly systemPrompt?: string;
  readonly semanticSupplementBinding?: SourceAssertionSupplementBinding;
}): void {
  assertSnapshotDatasetSubstrateIdentity(input);
  assertSnapshotSeedLedgerBinding({
    ...input,
    closureAuthority: { kind: "contained", questionWindow: input.questionWindow },
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt })
  });
}

function executionQuestionWindow(provenance: LongMemEvalRunProvenance) {
  return {
    offset: provenance.execution.offset,
    limit: provenance.execution.evaluated_count
  };
}

function assertRunAuthorityBinding(
  provenance: LongMemEvalRunProvenance,
  authority: SnapshotExtractionAuthority
): void {
  const cache = provenance.extraction_cache;
  if (cache?.schema_version !== 3) {
    throw new Error("snapshot writer requires current run extraction provenance");
  }
  assertSnapshotExtractionAuthorityBinding(authority, cache);
}

function extractionProvenance(
  identity: NonNullable<ReturnType<typeof readExtractionCacheManifestIdentity>>
): SnapshotExtractionProvenanceV3 {
  const manifest = identity.manifest;
  if (manifest.schema_version !== 3) {
    throw new Error("snapshot extraction provenance requires schema v3");
  }
  return buildSnapshotExtractionSummary(manifest, identity.manifestSha256);
}
