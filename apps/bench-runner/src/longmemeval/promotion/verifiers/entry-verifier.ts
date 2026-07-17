import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  computeLongMemEvalQuestionIdDigest,
  KpiPayloadSchema,
  evaluateSeedExtractionReleaseBlocker,
  isCacheOnlySeedExtractionPath,
  type KpiPayload,
  type LongMemEvalSelectionContractIdentity
} from "@do-soul/alaya-eval";
import { buildBenchmarkMeasurementAttribution } from
  "../../measurement/attribution.js";
import {
  isLongMemEvalRunProvenanceGateEligible,
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "../../provenance/run.js";
import type { RecallEvalDiagnosticsEvidenceV2 } from
  "../../provenance/recall-eval/recall-eval-diagnostics.js";
import {
  assertExpectedIdentity,
  openRecallEvalDiagnosticsArtifact,
  parseJsonArtifact,
  readRecallEvalPromotionManifest,
  readRecallEvalSmallArtifacts,
  requiredArtifactBytes,
  verifyRecallEvalArtifactSet
} from "../artifacts/artifact-reader.js";
import type {
  LongMemEvalMatrixPromotionContract,
  LongMemEvalMatrixTreatment
} from "../schema/contract.js";
import { verifyRecallEvalDiagnostics } from "./diagnostics-verifier.js";
import {
  RecallEvalRankIdentitySchema,
  type RecallEvalPromotionManifest,
  type RecallEvalRankIdentity
} from "../schema/evidence-schema.js";
import { immutableJsonClone } from "../schema/immutable-json.js";
import {
  verifiedPromotionSnapshotData,
  type VerifiedPromotionSnapshot,
  type VerifiedPromotionSnapshotData
} from "./snapshot-verifier.js";

declare const verifiedEntryBrand: unique symbol;

export interface VerifiedRecallEvalPromotionEntry {
  readonly [verifiedEntryBrand]: true;
}

export interface VerifiedRecallEvalPromotionEntryData {
  readonly entryRoot: string;
  readonly manifest: RecallEvalPromotionManifest;
  readonly payload: KpiPayload;
  readonly provenance: LongMemEvalRunProvenance;
  readonly diagnosticsRuntime: RecallEvalDiagnosticsEvidenceV2["runtime"];
  readonly treatment: LongMemEvalMatrixTreatment;
  readonly snapshot: VerifiedPromotionSnapshotData;
}

interface ParsedEntryEvidence {
  readonly manifest: RecallEvalPromotionManifest;
  readonly small: Awaited<ReturnType<typeof readRecallEvalSmallArtifacts>>;
  readonly payload: KpiPayload;
  readonly provenance: LongMemEvalRunProvenance;
  readonly rankIdentity: RecallEvalRankIdentity;
}

const verifiedEntries = new WeakMap<object, VerifiedRecallEvalPromotionEntryData>();

export async function verifyRecallEvalPromotionEntry(input: {
  readonly entryRoot: string;
  readonly expectedSelection: LongMemEvalSelectionContractIdentity;
  readonly treatment: LongMemEvalMatrixTreatment;
  readonly code: LongMemEvalMatrixPromotionContract["code"];
  readonly gateSha256: string;
  readonly snapshot: VerifiedPromotionSnapshot;
}): Promise<VerifiedRecallEvalPromotionEntry> {
  const snapshot = verifiedPromotionSnapshotData(input.snapshot);
  const evidence = await readEntryEvidence(input.entryRoot);
  assertEntryBindings({ ...input, ...evidence, snapshot });
  const diagnosticsRuntime = await verifyEntryDiagnostics(
    input,
    evidence,
    snapshot
  );
  return sealVerifiedEntry(input, evidence, diagnosticsRuntime, snapshot);
}

async function readEntryEvidence(entryRoot: string): Promise<ParsedEntryEvidence> {
  const manifest = await readRecallEvalPromotionManifest(entryRoot);
  const small = await readRecallEvalSmallArtifacts(entryRoot, manifest);
  const payload = KpiPayloadSchema.parse(parseJsonArtifact(
    requiredArtifactBytes(small, "kpi"),
    "recall-eval kpi"
  ));
  const provenance = LongMemEvalRunProvenanceSchema.parse(parseJsonArtifact(
    requiredArtifactBytes(small, "run_provenance"),
    "recall-eval run provenance"
  ));
  const rankIdentity = RecallEvalRankIdentitySchema.parse(parseJsonArtifact(
    requiredArtifactBytes(small, "rank_identity"),
    "recall-eval rank identity"
  ));
  return { manifest, small, payload, provenance, rankIdentity };
}

async function verifyEntryDiagnostics(
  input: Parameters<typeof verifyRecallEvalPromotionEntry>[0],
  evidence: ParsedEntryEvidence,
  snapshot: VerifiedPromotionSnapshotData
): Promise<RecallEvalDiagnosticsEvidenceV2["runtime"]> {
  const { manifest } = evidence;
  const diagnosticsArtifact = await openRecallEvalDiagnosticsArtifact(
    input.entryRoot,
    manifest
  );
  try {
    return await inspectEntryDiagnostics(
      input,
      evidence,
      snapshot,
      diagnosticsArtifact
    );
  } finally {
    await diagnosticsArtifact.file.close();
  }
}

async function inspectEntryDiagnostics(
  input: Parameters<typeof verifyRecallEvalPromotionEntry>[0],
  evidence: ParsedEntryEvidence,
  snapshot: VerifiedPromotionSnapshotData,
  diagnosticsArtifact: Awaited<ReturnType<typeof openRecallEvalDiagnosticsArtifact>>
): Promise<RecallEvalDiagnosticsEvidenceV2["runtime"]> {
  const { manifest, small, payload, provenance, rankIdentity } = evidence;
  const hash = createHash("sha256");
  let observedBytes = 0;
  const verifiedDiagnostics = await verifyRecallEvalDiagnostics({
    handle: diagnosticsArtifact.file.handle,
    payload,
    rankIdentity,
    treatment: input.treatment,
    goldForQuestion: snapshot.goldForQuestion,
    measurementForQuestion: snapshot.measurementForQuestion,
    observeChunk: (chunk) => {
      observedBytes += chunk.byteLength;
      hash.update(chunk);
    }
  });
  assertExpectedIdentity(
    diagnosticsArtifact.artifact,
    observedBytes,
    hash.digest("hex")
  );
  verifyRecallEvalArtifactSet(manifest, [
    ...small.identities,
    {
      role: "recall_eval_diagnostics" as const,
      path: diagnosticsArtifact.artifact.path,
      identity: {
        sha256: diagnosticsArtifact.artifact.sha256,
        bytes: diagnosticsArtifact.artifact.bytes
      }
    }
  ]);
  assertRuntimeBindings(
    payload,
    provenance,
    verifiedDiagnostics.runtime,
    input.treatment
  );
  assertMeasurementAttribution(payload);
  return verifiedDiagnostics.runtime;
}

function sealVerifiedEntry(
  input: Parameters<typeof verifyRecallEvalPromotionEntry>[0],
  evidence: ParsedEntryEvidence,
  diagnosticsRuntime: RecallEvalDiagnosticsEvidenceV2["runtime"],
  snapshot: VerifiedPromotionSnapshotData
): VerifiedRecallEvalPromotionEntry {
  const entry = Object.freeze({}) as VerifiedRecallEvalPromotionEntry;
  verifiedEntries.set(entry, Object.freeze({
    entryRoot: input.entryRoot,
    manifest: immutableJsonClone(evidence.manifest),
    payload: immutableJsonClone(evidence.payload),
    provenance: immutableJsonClone(evidence.provenance),
    diagnosticsRuntime: immutableJsonClone(diagnosticsRuntime),
    treatment: immutableJsonClone(input.treatment),
    snapshot
  }));
  return entry;
}

export function verifiedRecallEvalPromotionEntryData(
  entry: VerifiedRecallEvalPromotionEntry
): VerifiedRecallEvalPromotionEntryData {
  const data = verifiedEntries.get(entry);
  if (data === undefined) throw new Error("recall-eval promotion entry is not verified");
  return data;
}

function assertEntryBindings(input: {
  readonly manifest: RecallEvalPromotionManifest;
  readonly payload: KpiPayload;
  readonly provenance: LongMemEvalRunProvenance;
  readonly rankIdentity: RecallEvalRankIdentity;
  readonly expectedSelection: LongMemEvalSelectionContractIdentity;
  readonly code: LongMemEvalMatrixPromotionContract["code"];
  readonly gateSha256: string;
  readonly snapshot: VerifiedPromotionSnapshotData;
}): void {
  const { manifest, payload, provenance, rankIdentity, expectedSelection } = input;
  assertEqual(manifest.run.selection_contract, expectedSelection, "manifest selection");
  assertEqual(payload.selection_contract, expectedSelection, "KPI selection");
  assertEqual(provenance.selection, expectedSelection, "provenance selection");
  assertRunBinding(manifest, payload, provenance, expectedSelection);
  assertCodeBinding(provenance, input.code, input.gateSha256);
  assertRankBinding(rankIdentity, expectedSelection);
  assertAttributionBinding(payload, provenance, expectedSelection, input.snapshot);
  const extractionBlocker = evaluateSeedExtractionReleaseBlocker(payload);
  if (extractionBlocker !== null || !isCacheOnlySeedExtractionPath(
    payload.kpi.seed_extraction_path
  )) {
    throw new Error(
      `recall-eval seed extraction is not cache-only: ${extractionBlocker?.id ?? "unknown"}`
    );
  }
}

function assertRunBinding(
  manifest: RecallEvalPromotionManifest,
  payload: KpiPayload,
  provenance: LongMemEvalRunProvenance,
  expectedSelection: LongMemEvalSelectionContractIdentity
): void {
  if (manifest.run.dataset_sha256 !== expectedSelection.dataset_sha256 ||
      manifest.run.question_id_digest !== expectedSelection.selected_id_digest ||
      manifest.run.bench_name !== payload.bench_name ||
      manifest.run.split !== payload.split || manifest.run.run_at !== payload.run_at ||
      manifest.run.alaya_commit !== payload.alaya_commit ||
      payload.dataset.checksum_sha256 !== expectedSelection.dataset_sha256 ||
      payload.evaluated_count !== expectedSelection.selected_count ||
      payload.sample_size !== expectedSelection.selected_count) {
    throw new Error("recall-eval manifest/KPI run identity drift");
  }
  if (provenance.dataset_sha256 !== expectedSelection.dataset_sha256 ||
      provenance.execution.offset !== 0 || provenance.execution.limit !== null ||
      provenance.execution.evaluated_count !== expectedSelection.selected_count ||
      !isLongMemEvalRunProvenanceGateEligible(provenance)) {
    throw new Error("recall-eval run provenance is not full-snapshot gate eligible");
  }
}

function assertCodeBinding(
  provenance: LongMemEvalRunProvenance,
  code: LongMemEvalMatrixPromotionContract["code"],
  gateSha256: string
): void {
  if (provenance.code.commit_sha !== code.commit_sha ||
      provenance.code.commit_sha7 !== code.commit_sha7 ||
      provenance.code.worktree_state_sha256 !== code.worktree_state_sha256 ||
      provenance.code.gate_sha256 !== gateSha256 ||
      !isDeepStrictEqual(provenance.code.executed_dist, code.executed_dist)) {
    throw new Error("recall-eval code identity differs from frozen promotion contract");
  }
}

function assertRankBinding(
  rank: RecallEvalRankIdentity,
  selection: LongMemEvalSelectionContractIdentity
): void {
  const questionIdDigest = computeRankQuestionIdDigest(rank);
  if (rank.snapshot_binding.expected_question_count !== selection.selected_count ||
      rank.snapshot_binding.expected_question_id_digest !== selection.selected_id_digest ||
      rank.replay.question_count !== selection.selected_count ||
      rank.replay.question_id_digest !== selection.selected_id_digest ||
      rank.questions.length !== selection.selected_count ||
      questionIdDigest !== selection.selected_id_digest) {
    throw new Error("recall-eval rank identity differs from full snapshot selection");
  }
}

function computeRankQuestionIdDigest(rank: RecallEvalRankIdentity): string {
  try {
    return computeLongMemEvalQuestionIdDigest(
      rank.questions.map((question) => question.question_id)
    );
  } catch {
    throw new Error("recall-eval rank identity differs from full snapshot selection");
  }
}

function assertAttributionBinding(
  payload: KpiPayload,
  provenance: LongMemEvalRunProvenance,
  selection: LongMemEvalSelectionContractIdentity,
  verifiedSnapshot: VerifiedPromotionSnapshotData
): void {
  const attribution = payload.recall_eval_attribution;
  const snapshot = attribution?.snapshot_binding;
  const slice = attribution?.evaluation_slice;
  const cache = provenance.extraction_cache;
  if (attribution?.status !== "attributed" || attribution.gate_eligible !== true ||
      slice?.offset !== 0 || slice.limit !== null ||
      slice.evaluated_count !== selection.selected_count ||
      slice.question_id_digest !== selection.selected_id_digest ||
      attribution.hydration_binding?.dataset_sha256 !== selection.dataset_sha256 ||
      snapshot?.commit_sha7 !== provenance.code.commit_sha7 ||
      snapshot.gate_sha256 !== verifiedSnapshot.producerGateSha256 ||
      snapshot.worktree_state_sha256 !== provenance.code.worktree_state_sha256 ||
      snapshot.dataset_sha256 !== selection.dataset_sha256 ||
      snapshot.question_id_digest !== selection.selected_id_digest ||
      snapshot.snapshot_manifest_sha256 !== verifiedSnapshot.manifestSha256 ||
      snapshot.extraction_cache_manifest_sha256 !== cache?.manifest_sha256 ||
      snapshot.extraction_cache_requested_turns !== cache.requested_turns ||
      snapshot.extraction_cache_cached_turns !== cache.cached_turns ||
      snapshot.extraction_cache_coverage !== cache.coverage ||
      JSON.stringify(provenance.extraction_cache) !==
        verifiedSnapshot.producerExtractionCacheJson ||
      payload.recall_pipeline_version !== verifiedSnapshot.recallPipelineVersion ||
      snapshot.producer_recall_pipeline_version !== verifiedSnapshot.recallPipelineVersion ||
      snapshot.consumer_recall_pipeline_version !== payload.recall_pipeline_version ||
      snapshot.producer_schema_migration_version !==
        verifiedSnapshot.schemaMigrationVersion) {
    throw new Error("recall-eval snapshot attribution is incomplete or drifted");
  }
}

function assertRuntimeBindings(
  payload: KpiPayload,
  provenance: LongMemEvalRunProvenance,
  diagnostics: RecallEvalDiagnosticsEvidenceV2["runtime"],
  treatment: LongMemEvalMatrixTreatment
): void {
  const attribution = payload.recall_eval_attribution;
  if (attribution === undefined ||
      attribution.embedding_supplement === undefined ||
      attribution.answer_rerank === undefined ||
      attribution.recall_config === undefined) {
    throw new Error("recall-eval runtime attribution is incomplete");
  }
  assertEqual(diagnostics.embedding_supplement, attribution.embedding_supplement,
    "diagnostics/attribution bi-encoder identity");
  assertEqual(diagnostics.answer_rerank, attribution.answer_rerank,
    "diagnostics/attribution cross-encoder identity");
  assertEqual(diagnostics.embedding_supplement, provenance.runtime.embedding_supplement,
    "diagnostics/provenance bi-encoder identity");
  assertEqual(diagnostics.answer_rerank, provenance.runtime.answer_rerank,
    "diagnostics/provenance cross-encoder identity");
  assertEqual(attribution.recall_config, {
    schema_version: provenance.recall_config.schema_version,
    max_results: provenance.recall_config.max_results,
    conflict_awareness: provenance.recall_config.conflict_awareness,
    effective_config_sha256: provenance.recall_config.effective_config_sha256
  },
    "attribution/provenance recall config");
  if (diagnostics.embedding_supplement.enabled !== treatment.embedding_supplement ||
      diagnostics.answer_rerank.enabled !== treatment.answer_rerank ||
      attribution.node_version !== provenance.runtime.node_version ||
      attribution.platform !== provenance.runtime.platform ||
      attribution.arch !== provenance.runtime.arch ||
      attribution.embedding_mode !== provenance.runtime.embedding_mode ||
      attribution.embedding_provider_kind !== provenance.runtime.embedding_provider_kind ||
      attribution.embedding_provider_label !== provenance.runtime.embedding_provider_label ||
      attribution.onnx_threads !== provenance.runtime.onnx_threads ||
      attribution.embedding_provider_label !== payload.embedding_provider) {
    throw new Error("recall-eval runtime identity differs across artifacts");
  }
}

function assertMeasurementAttribution(payload: KpiPayload): void {
  const metrics = payload.kpi.quality_metrics;
  const expected = buildBenchmarkMeasurementAttribution({
    candidatePoolComplete: true,
    provenanceComplete: true,
    abstention: metrics?.abstention,
    noGoldCount: metrics?.no_gold_count,
    evaluatorIdentityIssueCount: metrics?.evaluator_identity_issue_count,
    evaluatorIdentityUnscorableCount: metrics?.evaluator_identity_unscorable_count
  });
  assertEqual(payload.measurement_attribution, expected, "measurement attribution");
  if (!expected.gate_eligible) {
    throw new Error("recall-eval measurement attribution is not gate eligible");
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} differs`);
}
