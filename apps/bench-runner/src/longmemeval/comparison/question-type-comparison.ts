import { isDeepStrictEqual } from "node:util";
import {
  LongMemEvalQuestionSchema,
  type LongMemEvalQuestion
} from "../ingestion/dataset.js";
import {
  assertCurrentComparisonEvidence,
  parseCurrentKpiEvidence,
  type CurrentKpiEvidence
} from "./current-kpi-evidence.js";
import {
  applyQuestionManifest,
  parseQuestionManifest,
  type QuestionManifest
} from "../selection/question-manifest.js";
import {
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "../provenance/run.js";
import { assertProductFormationEnvironment } from
  "../promotion/product/product-formation-policy.js";
import { validateCacheDatasetBinding } from "./cache-dataset-binding.js";
import {
  parseLongMemEvalVariant,
  requireNonEmptyString as requireString
} from "./dataset-identity.js";
import {
  buildQuestionTypeComparison,
  bytewiseCompare,
  type DatasetRow
} from "./build-question-type-comparison.js";
export interface HitRateSummary {
  readonly hits: number;
  readonly total: number;
  readonly any_at_5: number;
}
export interface ComparisonSummary {
  readonly control: HitRateSummary;
  readonly treatment: HitRateSummary;
  readonly delta_hits: number;
  readonly delta_any_at_5: number;
}
export interface QuestionTypeSummary extends ComparisonSummary {
  readonly question_type: string;
}
export interface AnswerabilitySummary extends ComparisonSummary {
  readonly cohort: "answerable" | "abstention";
  readonly total: number;
  readonly metric_kind: "gold_identity" | "abstention_fused_margin_heuristic";
  readonly calibration_status: "not_applicable" | "uncalibrated";
}
export interface QuestionTypeComparison {
  readonly schema_version: 2;
  readonly evidence_grade: "paired_attributed" | "legacy_unattributed";
  readonly question_count: number;
  readonly overall: ComparisonSummary;
  readonly question_types: readonly QuestionTypeSummary[];
  readonly answerability: readonly AnswerabilitySummary[];
  readonly latency: {
    readonly control_p95_ms: number;
    readonly treatment_p95_ms: number;
    readonly treatment_to_control_ratio: number | null;
    readonly within_105_percent: boolean;
  };
  readonly gate: {
    readonly evaluation_scope: "answerable_gold_bearing";
    readonly abstention_heuristic_calibrated: false;
    readonly gold_bearing_gain: boolean;
    readonly any_at_5_non_decreasing: boolean;
    readonly latency_within_105_percent: boolean;
    readonly question_type_non_regression: boolean;
    readonly regressed_question_types: readonly string[];
    readonly pass: boolean;
  } | null;
  readonly flips: {
    readonly gained: { readonly count: number; readonly question_ids: readonly string[] };
    readonly lost: { readonly count: number; readonly question_ids: readonly string[] };
    readonly net: number;
  };
}
interface ParsedKpi {
  readonly hits: ReadonlyMap<string, boolean>;
  readonly latencyP95: number;
  readonly identity: Readonly<Record<string, unknown>>;
  readonly currentEvidence: CurrentKpiEvidence;
}
export interface CompareQuestionTypesInput {
  readonly dataset: unknown;
  readonly datasetSha256?: string;
  readonly control: unknown;
  readonly treatment: unknown;
  readonly manifest?: unknown;
  readonly manifestFileSha256?: string;
  readonly controlProvenance?: unknown;
  readonly treatmentProvenance?: unknown;
  readonly allowLegacyUnattributed?: boolean;
}
export function compareLongMemEvalQuestionTypes(
  input: CompareQuestionTypesInput
): QuestionTypeComparison {
  const dataset = parseDataset(input.dataset);
  const control = parseKpi(input.control, "control");
  const treatment = parseKpi(input.treatment, "treatment");
  assertSameSet(control.hits.keys(), treatment.hits.keys(), "control/treatment question set mismatch");
  assertKnownDatasetIds(control.hits.keys(), dataset);
  assertCompatibleArtifactIdentity(control.identity, treatment.identity);
  const grade = validatePairedProvenance(input, control, treatment);
  validateManifestSelection(input, dataset, control, grade);

  const rows = [...control.hits.keys()].sort(bytewiseCompare).map((questionId) => {
    const datasetRow = dataset.get(questionId);
    if (datasetRow === undefined) throw new Error(`unknown dataset question id '${questionId}'`);
    return {
      ...datasetRow,
      controlHit: control.hits.get(questionId)!,
      treatmentHit: treatment.hits.get(questionId)!
    };
  });
  return buildQuestionTypeComparison(rows, control.latencyP95, treatment.latencyP95, grade);
}

function parseDataset(value: unknown): Map<string, DatasetRow> {
  if (!Array.isArray(value)) throw new Error("dataset must be an array");
  const result = new Map<string, DatasetRow>();
  for (const [index, row] of value.entries()) {
    const parsed = LongMemEvalQuestionSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`dataset[${index}] invalid: ${parsed.error.message}`);
    }
    const question = parsed.data;
    assertAnswerabilityConsistency(question, index);
    const questionId = question.question_id;
    const questionType = question.question_type;
    if (result.has(questionId)) throw new Error(`duplicate dataset question_id '${questionId}'`);
    result.set(questionId, { questionId, questionType, question });
  }
  return result;
}

function assertAnswerabilityConsistency(question: LongMemEvalQuestion, index: number): void {
  const validSourceSessions = question.answer_session_ids.length > 0 &&
    question.answer_session_ids.every((id) => id.trim().length > 0);
  if (!validSourceSessions) {
    throw new Error(
      `dataset[${index}].answer_session_ids must contain non-empty source session IDs`
    );
  }
}

function parseKpi(value: unknown, label: "control" | "treatment"): ParsedKpi {
  const root = requireRecord(value, label);
  const kpi = requireRecord(root.kpi, `${label}.kpi`);
  const hits = parsePerScenario(kpi.per_scenario, label);
  const latencyP95 = requireNonnegativeNumber(kpi.latency_ms_p95, `${label}.kpi.latency_ms_p95`);
  const dataset = requireRecord(root.dataset, `${label}.dataset`);
  const currentEvidence = parseCurrentKpiEvidence(value);
  return {
    hits,
    latencyP95,
    currentEvidence,
    identity: {
      bench_name: requireString(root.bench_name, `${label}.bench_name`),
      split: requireString(root.split, `${label}.split`),
      alaya_commit: requireString(root.alaya_commit, `${label}.alaya_commit`),
      alaya_version: requireString(root.alaya_version, `${label}.alaya_version`),
      recall_pipeline_version: root.recall_pipeline_version ?? null,
      embedding_provider: requireString(root.embedding_provider, `${label}.embedding_provider`),
      chat_provider: requireString(root.chat_provider, `${label}.chat_provider`),
      policy_shape: requireString(root.policy_shape, `${label}.policy_shape`),
      simulate_report: requireString(root.simulate_report, `${label}.simulate_report`),
      recall_weight_overrides: root.recall_weight_overrides ?? null,
      seed_policy: root.seed_policy ?? null,
      dataset_name: requireString(dataset.name, `${label}.dataset.name`),
      dataset_checksum_sha256: requireString(
        dataset.checksum_sha256,
        `${label}.dataset.checksum_sha256`
      ),
      sample_size: requireNonnegativeInteger(root.sample_size, `${label}.sample_size`),
      evaluated_count: requireNonnegativeInteger(root.evaluated_count, `${label}.evaluated_count`),
      harness_mode: requireString(root.harness_mode, `${label}.harness_mode`)
    }
  };
}

function parsePerScenario(value: unknown, label: string): Map<string, boolean> {
  if (!Array.isArray(value)) throw new Error(`${label}.kpi.per_scenario must be an array`);
  const result = new Map<string, boolean>();
  for (const [index, row] of value.entries()) {
    const record = requireRecord(row, `${label}.kpi.per_scenario[${index}]`);
    const id = requireString(record.id, `${label}.kpi.per_scenario[${index}].id`);
    if (typeof record.hit_at_5 !== "boolean") {
      throw new Error(`${label}.kpi.per_scenario[${index}].hit_at_5 must be boolean`);
    }
    if (result.has(id)) throw new Error(`duplicate ${label} question id '${id}'`);
    result.set(id, record.hit_at_5);
  }
  return result;
}

function validatePairedProvenance(
  input: CompareQuestionTypesInput,
  control: ParsedKpi,
  treatment: ParsedKpi
): QuestionTypeComparison["evidence_grade"] {
  if (input.controlProvenance === undefined || input.treatmentProvenance === undefined) {
    if (
      input.allowLegacyUnattributed === true &&
      input.controlProvenance === undefined &&
      input.treatmentProvenance === undefined &&
      input.manifest === undefined
    ) return "legacy_unattributed";
    throw new Error("paired comparison requires control and treatment run provenance");
  }
  const controlProvenance = parseProvenance(input.controlProvenance, "control");
  const treatmentProvenance = parseProvenance(input.treatmentProvenance, "treatment");
  assertCurrentComparisonEvidence(control.currentEvidence, "control");
  assertCurrentComparisonEvidence(treatment.currentEvidence, "treatment");
  assertSequentialProtocol(controlProvenance, "control", control.hits.size);
  assertSequentialProtocol(treatmentProvenance, "treatment", treatment.hits.size);
  assertPairedRunProvenance(controlProvenance, treatmentProvenance);
  validateAttributedProvenance(controlProvenance, control.identity, input.datasetSha256);
  if (controlProvenance.question_manifest !== null && input.manifest === undefined) {
    throw new Error("manifest-attributed comparison requires the supplied question manifest");
  }
  if (controlProvenance.recall_config.conf_slice_compatibility) {
    throw new Error("control provenance must disable confSliceCompatibility");
  }
  if (!treatmentProvenance.recall_config.conf_slice_compatibility) {
    throw new Error("treatment provenance must enable confSliceCompatibility");
  }
  if (treatmentProvenance.seed_capabilities?.facet_tags_enabled !== true) {
    throw new Error(
      "attributed slice comparison requires snapshot seed capability ALAYA_RECALL_FACET_TAGS=1"
    );
  }
  return "paired_attributed";
}

function assertPairedRunProvenance(
  control: LongMemEvalRunProvenance,
  treatment: LongMemEvalRunProvenance
): void {
  const { recall_config: controlConfig, ...controlPaired } = control;
  const { recall_config: treatmentConfig, ...treatmentPaired } = treatment;
  if (!isDeepStrictEqual(controlPaired, treatmentPaired)) {
    throw new Error("control/treatment provenance or config mismatch");
  }
  const { conf_slice_compatibility: _controlSwitch, ...controlStableConfig } =
    controlConfig;
  const { conf_slice_compatibility: _treatmentSwitch, ...treatmentStableConfig } =
    treatmentConfig;
  if (!isDeepStrictEqual(controlStableConfig, treatmentStableConfig)) {
    throw new Error("control/treatment recall config mismatch");
  }
}

function validateAttributedProvenance(
  provenance: LongMemEvalRunProvenance,
  identity: Readonly<Record<string, unknown>>,
  actualDatasetSha256: string | undefined
): void {
  if (provenance.code.gate_sha256 === null) {
    throw new Error("attributed comparison requires ALAYA_BENCH_GATE_SHA256 provenance");
  }
  if (provenance.code.worktree_state_sha256 === null) {
    throw new Error("attributed comparison requires ALAYA_BENCH_WORKTREE_STATE_SHA256 provenance");
  }
  if (provenance.code.commit_sha7 !== identity.alaya_commit) {
    throw new Error("run provenance commit does not match KPI artifact");
  }
  const cache = provenance.extraction_cache;
  if (cache === null) throw new Error("attributed comparison requires extraction cache provenance");
  validateCacheDatasetBinding(
    cache,
    provenance.question_manifest,
    identity,
    actualDatasetSha256
  );
  if (cache.coverage !== 1) throw new Error("attributed comparison requires extraction cache coverage=1");
  const runtime = provenance.runtime;
  if (
    runtime.embedding_mode !== "env" ||
    runtime.embedding_provider_kind !== "local_onnx" ||
    runtime.onnx_threads === null
  ) throw new Error("attributed comparison requires explicit local ONNX runtime identity");
  if (runtime.embedding_provider_label !== identity.embedding_provider) {
    throw new Error("run provenance embedding identity does not match KPI artifact");
  }
  if (runtime.onnx_model_artifact_sha256 === undefined) {
    throw new Error("attributed comparison requires local ONNX artifact SHA-256 provenance");
  }
  requirePairedEnv(runtime.paired_env, "ALAYA_BENCH_ALLOW_LIVE_EXTRACTION", "0");
  requirePairedEnv(runtime.paired_env, "ALAYA_BENCH_EXTRACTION_CACHE_MIN_COVERAGE", "1");
  requirePairedEnv(runtime.paired_env, "OFFICIAL_API_GARDEN_MODEL", cache.extraction_model);
  requirePairedEnv(runtime.paired_env, "ALAYA_RECALL_ANSWERS_WITH", "1");
  assertProductFormationEnvironment(
    runtime.paired_env,
    "attributed comparison product formation"
  );
}

function requirePairedEnv(
  env: Readonly<Record<string, string>>,
  key: string,
  expected: string
): void {
  if (env[key] !== expected) {
    throw new Error(`attributed comparison requires ${key}=${expected}`);
  }
}

function validateManifestSelection(
  input: CompareQuestionTypesInput,
  dataset: ReadonlyMap<string, DatasetRow>,
  control: ParsedKpi,
  grade: QuestionTypeComparison["evidence_grade"]
): void {
  if (grade !== "paired_attributed") {
    if (input.manifest !== undefined) {
      throw new Error("manifest comparison requires attributed provenance");
    }
    return;
  }
  const datasetSha256 = requireActualDatasetSha256(input.datasetSha256);
  if (input.manifest === undefined) {
    validateFullDatasetSelection(input, dataset, control);
    return;
  }
  const manifest = parseQuestionManifest(input.manifest);
  const datasetName = requireString(control.identity.dataset_name, "control.dataset.name");
  const datasetChecksum = requireString(
    control.identity.dataset_checksum_sha256,
    "control.dataset.checksum_sha256"
  );
  if (datasetChecksum !== "unpinned" && datasetChecksum !== datasetSha256) {
    throw new Error("artifact/actual dataset SHA-256 mismatch");
  }
  const selected = applyQuestionManifest(
    [...dataset.values()].map((row) => row.question),
    manifest,
    { variant: parseLongMemEvalVariant(datasetName), datasetSha256 }
  );
  assertSameSet(selected.map((row) => row.question_id), control.hits.keys(), "manifest/KPI question set mismatch");
  validateManifestProvenance(input, manifest);
}

function validateFullDatasetSelection(
  input: CompareQuestionTypesInput,
  dataset: ReadonlyMap<string, DatasetRow>,
  control: ParsedKpi
): void {
  assertSameSet(
    dataset.keys(),
    control.hits.keys(),
    "manifest-free attributed comparison cannot select a dataset subset"
  );
  assertFullExecutionWindow(parseProvenance(input.controlProvenance, "control"), dataset.size);
  assertFullExecutionWindow(parseProvenance(input.treatmentProvenance, "treatment"), dataset.size);
}

function assertFullExecutionWindow(
  provenance: LongMemEvalRunProvenance,
  datasetSize: number
): void {
  const execution = provenance.execution;
  if (
    execution.offset !== 0 ||
    execution.limit !== null ||
    execution.evaluated_count !== datasetSize
  ) {
    throw new Error("manifest-free attributed comparison requires a full execution window");
  }
}

function requireActualDatasetSha256(value: string | undefined): string {
  if (value === undefined || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("attributed comparison requires actual dataset SHA-256");
  }
  return value;
}

function validateManifestProvenance(
  input: CompareQuestionTypesInput,
  manifest: QuestionManifest
): void {
  const control = parseProvenance(input.controlProvenance, "control");
  const identity = control.question_manifest;
  if (identity === null) throw new Error("run provenance is missing question manifest identity");
  if (input.manifestFileSha256 === undefined) {
    throw new Error("manifest comparison requires manifest file SHA-256");
  }
  const expected = {
    schema_version: manifest.schema_version,
    variant: manifest.variant,
    dataset_sha256: manifest.dataset_sha256,
    algorithm_version: manifest.algorithm_version,
    target_count: manifest.target_count,
    selected_id_digest: manifest.selected_id_digest,
    file_sha256: input.manifestFileSha256
  };
  if (!isDeepStrictEqual(identity, expected)) {
    throw new Error("question manifest provenance does not match supplied manifest");
  }
}

function parseProvenance(value: unknown, label: string): LongMemEvalRunProvenance {
  const parsed = LongMemEvalRunProvenanceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} run provenance invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

function assertSequentialProtocol(
  provenance: LongMemEvalRunProvenance,
  label: string,
  questionCount: number
): void {
  if (provenance.execution.protocol !== "sequential" || provenance.execution.concurrency !== 1) {
    throw new Error(`${label} run must use the sequential protocol`);
  }
  if (provenance.execution.evaluated_count !== questionCount) {
    throw new Error(`${label} provenance evaluated count does not match KPI rows`);
  }
}

function assertCompatibleArtifactIdentity(
  control: Readonly<Record<string, unknown>>,
  treatment: Readonly<Record<string, unknown>>
): void {
  if (!isDeepStrictEqual(control, treatment)) {
    throw new Error("control/treatment artifact provenance or config mismatch");
  }
}

function assertKnownDatasetIds(ids: Iterable<string>, dataset: ReadonlyMap<string, DatasetRow>): void {
  for (const id of ids) if (!dataset.has(id)) throw new Error(`unknown dataset question id '${id}'`);
}

function assertSameSet(left: Iterable<string>, right: Iterable<string>, message: string): void {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const leftOnly = [...leftSet].filter((id) => !rightSet.has(id)).sort(bytewiseCompare);
  const rightOnly = [...rightSet].filter((id) => !leftSet.has(id)).sort(bytewiseCompare);
  if (leftOnly.length > 0 || rightOnly.length > 0) {
    throw new Error(`${message}: left_only=[${leftOnly.join(",")}], right_only=[${rightOnly.join(",")}]`);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonnegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, field: string): number {
  const parsed = requireNonnegativeNumber(value, field);
  if (!Number.isInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}

export { renderQuestionTypeComparisonMarkdown } from "./render-question-type-comparison.js";
