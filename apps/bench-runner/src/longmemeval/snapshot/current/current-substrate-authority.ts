import { readFileSync } from "node:fs";
import { isCacheOnlySeedExtractionPath, type SeedExtractionPath } from
  "@do-soul/alaya-eval";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { resolveCompileSeedExtractionConfig } from
  "../../compile-seed/compile-seed-config.js";
import { preflightExtractionCache } from "../../compile-seed/compile-seed-preflight.js";
import type { LongMemEvalQuestion, LongMemEvalVariant } from "../../ingestion/dataset.js";
import {
  readExtractionCacheManifestIdentity
} from "../../extraction/cache/extraction-cache-manifest.js";
import { hasCompleteExtractionFillAuthority, hasCompleteExtractionFillSummary } from
  "../../extraction/fill/fill-authority.js";
import type { ExtractionFillQuestionWindow } from
  "../../extraction/fill/manifest/fill-manifest-contract.js";
import type { LongMemEvalExtractionTurn } from "../../extraction/turn-contents.js";
import { loadDatasetWithIdentity } from "../../ingestion/fetch.js";
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

export function assertCacheOnlyEnvironment(
  env: Readonly<Record<string, string | undefined>>
): void {
  const live = env.ALAYA_BENCH_ALLOW_LIVE_EXTRACTION?.trim().toLowerCase();
  const credential = env.ALAYA_OFFICIAL_GARDEN_SECRET_REF?.trim() ||
    env.ALAYA_GARDEN_OPENAI_SECRET_REF?.trim();
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
  assertCacheOnlyEnvironment(input.env);
  const identity = readExtractionCacheManifestIdentity(input.cacheRoot);
  if (identity === undefined || identity.manifest.schema_version !== 3 ||
      !hasCompleteExtractionFillAuthority(identity.manifest)) {
    throw new Error("post-fill benchmark requires a complete v3 extraction manifest");
  }
  if (identity.manifest.dataset_revision !== input.datasetSha256) {
    throw new Error("post-fill extraction manifest dataset identity mismatch");
  }
  const config = resolveCompileSeedExtractionConfig(
    { ...input.env },
    identity.manifest
  );
  preflightExtractionCache({
    cacheRoot: input.cacheRoot,
    config,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    allowLiveExtraction: false,
    liveExtractionPossible: false,
    manifest: identity.manifest,
    requiredTurnContents: input.requiredTurnContents,
    requiredExtractionTurns: input.requiredExtractionTurns,
    requiredQuestionWindow: input.requiredQuestionWindow,
    requireManifest: true
  });
  return extractionProvenance(identity);
}

export function assertCurrentSnapshotWriteAuthority(input: {
  readonly dbPath: string;
  readonly sidecar: LongMemEvalSnapshotSidecarFile;
  readonly canonicalQuestions: readonly LongMemEvalQuestion[];
  readonly extraction: SnapshotExtractionProvenanceV3;
  readonly extractionAuthority: SnapshotExtractionAuthority;
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
}): Promise<{
  readonly datasetSha256: string;
  readonly measurementForQuestion: SnapshotMeasurementOracleAccessor;
}> {
  assertCurrentSnapshotAttributionClaim(input.manifest);
  const extraction = assertCurrentManifestAuthority(input.manifest);
  assertSnapshotExtractionAuthorityBinding(input.extractionAuthority, extraction);
  const runProvenance = bindCurrentRunProvenance(
    input.manifest,
    input.extractionAuthority
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
    questionWindow: executionQuestionWindow(runProvenance)
  });
  return {
    datasetSha256: dataset.sha256,
    measurementForQuestion: buildSnapshotMeasurementOracle(questions, input.sidecar)
  };
}

function bindCurrentRunProvenance(
  manifest: LongMemEvalSnapshotManifest,
  extractionAuthority: SnapshotExtractionAuthority
): LongMemEvalRunProvenance {
  const runProvenance = bindSnapshotRunProvenanceAuthority(
    manifest.run_provenance!,
    extractionAuthority
  );
  if (!isLongMemEvalRunProvenanceGateEligible(runProvenance)) {
    throw new Error("current recall-eval snapshot run authority is incomplete");
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
}): void {
  assertSnapshotDatasetSubstrateIdentity(input);
  assertSnapshotSeedLedgerBinding({
    ...input,
    closureAuthority: { kind: "contained", questionWindow: input.questionWindow }
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
