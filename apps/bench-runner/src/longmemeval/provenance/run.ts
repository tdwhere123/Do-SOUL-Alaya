import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseRecallRuntimeConfigFromEnv } from "@do-soul/alaya-core";
import { z } from "zod";
import {
  readOptionalOnnxThreadCount,
  readOptionalTreatmentBoolean
} from "../../harness/strict-treatment-config.js";
import {
  parseQuestionManifest,
  type QuestionManifest
} from "../selection/question-manifest.js";
import type { LongMemEvalRunOptions } from "../runner.js";
import {
  EXTRACTION_CACHE_MANIFEST_VERSION,
  EXTRACTION_REQUEST_PROFILES,
  readExtractionCacheManifestIdentity
} from "../extraction-cache-manifest.js";
import {
  resolveEmbeddingSupplementRuntimeProvenance,
  resolveLocalCrossEncoderRuntimeProvenance
} from "./local-onnx.js";
import { DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND } from "../../harness/daemon-types.js";
import {
  buildEffectiveRecallConfigIdentity,
  EFFECTIVE_RECALL_CONFIG_SCHEMA_VERSION,
  type EffectiveRecallOptions
} from "./effective-recall-config.js";

export const LONGMEMEVAL_RUN_PROVENANCE_FILENAME =
  "longmemeval-run-provenance.json";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ExecutedDistIdentitySchema = z.object({
  algorithm: z.literal("sha256-reachable-path-file-sha256-v1"),
  sha256: Sha256Schema,
  file_count: z.number().int().positive()
}).strict();
const AnswerRerankRuntimeProvenanceSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    provider_kind: z.literal("local_onnx_cross_encoder"),
    effective_model_id: z.string().min(1),
    model_artifact_sha256: Sha256Schema
  }).strict()
]);
const EmbeddingSupplementRuntimeProvenanceSchema = z.union([
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true), provider_kind: z.literal("local_onnx"),
    effective_model_id: z.string().min(1), model_artifact_sha256: Sha256Schema,
    effective_schema_version: z.number().int().positive(),
    d2q_input: z.enum(["raw_content", "content_plus_hq"])
  }).strict(),
  z.object({
    enabled: z.literal(true), provider_kind: z.literal("openai"),
    effective_model_id: z.string().min(1), effective_schema_version: z.literal(1),
    d2q_input: z.literal("raw_content")
  }).strict()
]);
const execFileAsync = promisify(execFile);
const PAIRED_ENV_ALLOWLIST = new Set([
  "ALAYA_BENCH_ALLOW_LIVE_EXTRACTION",
  "ALAYA_BENCH_EXTRACTION_CACHE_MIN_COVERAGE",
  "ALAYA_BENCH_EXTRACTION_MODEL_FAMILY",
  "ALAYA_CONFLICT_DETECTION_ENABLED",
  "ALAYA_EMBEDDING_PROVIDER",
  "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
  "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK",
  "ALAYA_EXP_ANSWERS_WITH_BAR",
  "ALAYA_EXP_ANSWERS_WITH_CAP",
  "ALAYA_EXP_ANSWERS_WITH_XSESSION",
  "ALAYA_EXP_COHERENCE_CAP",
  "ALAYA_EXP_COHERENCE_EDGES",
  "ALAYA_EXP_COHERENCE_FLOOR",
  "ALAYA_EXP_COHERENCE_XSESSION",
  "ALAYA_GARDEN_PROVIDER_KIND",
  "ALAYA_INGEST_RECONCILIATION_ENABLED",
  "ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT",
  "ALAYA_LOCAL_ONNX_THREADS",
  "ALAYA_LOCAL_EMBEDDING_MODEL",
  "ALAYA_LOCAL_CROSS_ENCODER_MODEL",
  "ALAYA_RECALL_ANSWERS_WITH",
  "ALAYA_RECALL_COARSE_FLOOR",
  "ALAYA_RECALL_CONF_EVIDENCE_BETA",
  "ALAYA_RECALL_CONF_FLOOD_CAP",
  "ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL",
  "ALAYA_RECALL_CONF_RHO_EVIDENCE",
  "ALAYA_RECALL_CONF_RHO_PATH",
  "ALAYA_RECALL_CONF_W_PATH",
  "ALAYA_RECALL_FACET_TAGS",
  "ALAYA_RECALL_D2Q",
  "ALAYA_RECALL_EVAL_EMBEDDING",
  "ALAYA_RECALL_SOURCE_REF_ROBUST",
  "OFFICIAL_API_GARDEN_MODEL"
]);

const ExtractionCacheIdentityBaseSchema = z.object({
  manifest_sha256: Sha256Schema,
  extraction_model: z.string().min(1),
  provider_url: z.string().min(1),
  system_prompt_sha256: Sha256Schema,
  cache_key_algo: z.string().min(1),
  dataset: z.string().min(1),
  dataset_revision: z.string().min(1),
  requested_turns: z.number().int().nonnegative().optional(),
  cached_turns: z.number().int().nonnegative().optional(),
  coverage: z.number().min(0).max(1).optional(),
  storage: z.enum(["git-tracked", "archive"]),
  archive_url: z.string().min(1).optional(),
  archive_sha256: Sha256Schema.optional(),
  built_at: z.string().min(1),
  builder: z.string().min(1)
}).strict();

const ExtractionCacheIdentitySchema = z.discriminatedUnion("schema_version", [
  ExtractionCacheIdentityBaseSchema.extend({
    schema_version: z.literal(1),
    model_family: z.never().optional(),
    request_profile: z.never().optional()
  }).strict(),
  ExtractionCacheIdentityBaseSchema.extend({
    schema_version: z.literal(2),
    model_family: z.string().min(1),
    request_profile: z.never().optional()
  }).strict(),
  ExtractionCacheIdentityBaseSchema.extend({
    schema_version: z.literal(EXTRACTION_CACHE_MANIFEST_VERSION),
    model_family: z.string().min(1),
    request_profile: z.enum(EXTRACTION_REQUEST_PROFILES)
  }).strict()
]);

export const LongMemEvalRunProvenanceSchema = z.object({
  schema_version: z.literal(1),
  code: z.object({
    commit_sha7: z.string().regex(/^[a-f0-9]{7}$/u),
    gate_sha256: Sha256Schema.nullable(),
    worktree_state_sha256: Sha256Schema.nullable(),
    executed_dist: ExecutedDistIdentitySchema.nullable().default(null)
  }).strict(),
  extraction_cache: ExtractionCacheIdentitySchema.nullable(),
  runtime: z.object({
    node_version: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    embedding_mode: z.enum(["disabled", "env"]),
    embedding_provider_kind: z.enum(["openai", "local_onnx"]),
    embedding_provider_label: z.string().min(1),
    onnx_threads: z.number().int().min(1).max(64).nullable(),
    onnx_model_artifact_sha256: Sha256Schema.optional(),
    embedding_supplement: EmbeddingSupplementRuntimeProvenanceSchema.optional(),
    answer_rerank: AnswerRerankRuntimeProvenanceSchema.optional(),
    paired_env: z.record(z.string(), z.string())
  }).strict(),
  execution: z.object({
    protocol: z.literal("sequential"),
    concurrency: z.literal(1),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().nullable(),
    evaluated_count: z.number().int().nonnegative()
  }).strict(),
  recall_config: z.object({
    conf_slice_compatibility: z.boolean(),
    schema_version: z.union([
      z.literal(1),
      z.literal(EFFECTIVE_RECALL_CONFIG_SCHEMA_VERSION)
    ]).optional(),
    max_results: z.number().int().min(1).max(1_000).optional(),
    conflict_awareness: z.boolean().optional(),
    effective_config_sha256: Sha256Schema.optional()
  }).strict(),
  seed_capabilities: z.object({
    facet_tags_enabled: z.boolean()
  }).strict().optional(),
  question_manifest: z.object({
    schema_version: z.literal(1),
    variant: z.enum(["longmemeval_oracle", "longmemeval_s", "longmemeval_m"]),
    dataset_sha256: Sha256Schema,
    algorithm_version: z.string().min(1),
    target_count: z.number().int().positive(),
    selected_id_digest: Sha256Schema,
    file_sha256: Sha256Schema
  }).strict().nullable()
}).strict();

export type LongMemEvalRunProvenance = z.infer<
  typeof LongMemEvalRunProvenanceSchema
>;

export async function buildLongMemEvalRunProvenance(input: {
  readonly opts: LongMemEvalRunOptions;
  readonly evaluatedCount: number;
  readonly commitSha7: string;
  readonly embeddingProviderLabel: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly recallOptions?: EffectiveRecallOptions;
  readonly runtime?: {
    readonly nodeVersion: string;
    readonly platform: string;
    readonly arch: string;
  };
  readonly computeExecutedDistIdentity?: () => Promise<unknown>;
}): Promise<LongMemEvalRunProvenance> {
  const executedDist = await resolveExecutedDistIdentity(input);
  return LongMemEvalRunProvenanceSchema.parse({
    schema_version: 1,
    code: buildCodeIdentity(input, executedDist),
    extraction_cache: await readExtractionCacheIdentity(input.opts, input.env),
    runtime: await buildRuntimeIdentity(input),
    execution: buildExecutionIdentity(input),
    recall_config: buildRunRecallConfig(input),
    seed_capabilities: buildSeedCapabilities(input.env),
    question_manifest: await readManifestIdentity(input.opts.questionManifest)
  });
}

function buildCodeIdentity(
  input: Parameters<typeof buildLongMemEvalRunProvenance>[0],
  executedDist: NonNullable<LongMemEvalRunProvenance["code"]["executed_dist"]>
) {
  return {
    commit_sha7: input.commitSha7,
    gate_sha256: readOptionalSha(input.env.ALAYA_BENCH_GATE_SHA256, "ALAYA_BENCH_GATE_SHA256"),
    worktree_state_sha256: readOptionalSha(
      input.env.ALAYA_BENCH_WORKTREE_STATE_SHA256,
      "ALAYA_BENCH_WORKTREE_STATE_SHA256"
    ),
    executed_dist: executedDist
  };
}

function buildExecutionIdentity(
  input: Parameters<typeof buildLongMemEvalRunProvenance>[0]
) {
  return {
    protocol: "sequential" as const,
    concurrency: 1 as const,
    offset: input.opts.offset ?? 0,
    limit: input.opts.limit ?? null,
    evaluated_count: input.evaluatedCount
  };
}

function buildRunRecallConfig(
  input: Parameters<typeof buildLongMemEvalRunProvenance>[0]
) {
  const recall = parseRecallRuntimeConfigFromEnv(input.env);
  return {
    conf_slice_compatibility: recall.confSliceCompatibility,
    ...buildEffectiveRecallConfigIdentity(input.env, input.recallOptions ?? {
      maxResults: 10,
      conflictAwareness: (input.opts.policyShape ?? "stress") !== "chat"
    })
  };
}

function buildSeedCapabilities(env: Readonly<Record<string, string | undefined>>) {
  return {
    facet_tags_enabled: /^(?:1|true|on|yes)$/iu.test(env.ALAYA_RECALL_FACET_TAGS ?? "")
  };
}

async function resolveExecutedDistIdentity(
  input: Parameters<typeof buildLongMemEvalRunProvenance>[0]
): Promise<NonNullable<LongMemEvalRunProvenance["code"]["executed_dist"]>> {
  const raw = await (input.computeExecutedDistIdentity ?? computeExecutedDistIdentityFresh)();
  const parsed = ExecutedDistIdentitySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("executed dist closure is missing or invalid", { cause: parsed.error });
  }
  const measured = parsed.data;
  assertExpectedExecutedDistIdentity(input.env, measured);
  return measured;
}

function assertExpectedExecutedDistIdentity(
  env: Readonly<Record<string, string | undefined>>,
  measured: NonNullable<LongMemEvalRunProvenance["code"]["executed_dist"]>
): void {
  const sha = env.ALAYA_BENCH_EXECUTED_DIST_CLOSURE_SHA256;
  const count = env.ALAYA_BENCH_EXECUTED_DIST_FILE_COUNT;
  if (sha === undefined && count === undefined) return;
  if (sha === undefined || count === undefined) {
    throw new Error("executed dist provenance requires both sha256 and file count");
  }
  if (sha !== measured.sha256 || Number(count) !== measured.file_count) {
    throw new Error("executed dist environment identity does not match fresh closure");
  }
}

async function computeExecutedDistIdentityFresh(): Promise<unknown> {
  const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
  const script = join(checkoutRoot, "apps/bench-runner/scripts/executed-dist-closure.mjs");
  const { stdout } = await execFileAsync(process.execPath, [script, "--root", checkoutRoot]);
  return JSON.parse(stdout);
}

async function buildRuntimeIdentity(
  input: Parameters<typeof buildLongMemEvalRunProvenance>[0]
): Promise<LongMemEvalRunProvenance["runtime"]> {
  const runtime = input.runtime ?? {
    nodeVersion: process.version,
    platform: platform(),
    arch: arch()
  };
  const embeddingMode = input.opts.embeddingMode ?? "disabled";
  const providerKind = input.opts.embeddingProviderKind ??
    DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND;
  const [embeddingSupplement, answerRerank] = await Promise.all([
    resolveEmbeddingSupplementRuntimeProvenance(
      embeddingMode, providerKind, input.env, input.embeddingProviderLabel
    ),
    resolveLocalCrossEncoderRuntimeProvenance(input.env)
  ]);
  return {
    node_version: runtime.nodeVersion,
    platform: runtime.platform,
    arch: runtime.arch,
    embedding_mode: embeddingMode,
    embedding_provider_kind: providerKind,
    embedding_provider_label: input.embeddingProviderLabel,
    onnx_threads: readOptionalOnnxThreadCount(input.env.ALAYA_LOCAL_ONNX_THREADS),
    ...(embeddingSupplement.enabled && embeddingSupplement.provider_kind === "local_onnx"
      ? { onnx_model_artifact_sha256: embeddingSupplement.model_artifact_sha256 }
      : {}),
    embedding_supplement: embeddingSupplement,
    answer_rerank: answerRerank,
    paired_env: collectPairedEnvironment(input.env)
  };
}

export async function buildLongMemEvalRunProvenanceSidecar(
  input: Parameters<typeof buildLongMemEvalRunProvenance>[0]
): Promise<{ readonly filename: string; readonly contents: string }> {
  return {
    filename: LONGMEMEVAL_RUN_PROVENANCE_FILENAME,
    contents: renderLongMemEvalRunProvenance(
      await buildLongMemEvalRunProvenance(input)
    )
  };
}

export function renderLongMemEvalRunProvenance(
  provenance: LongMemEvalRunProvenance
): string {
  return `${JSON.stringify(provenance, null, 2)}\n`;
}

export function isLongMemEvalRunProvenanceGateEligible(
  provenance: LongMemEvalRunProvenance
): boolean {
  const cache = provenance.extraction_cache;
  return provenance.code.gate_sha256 !== null &&
    provenance.code.worktree_state_sha256 !== null &&
    provenance.code.executed_dist !== null && cache !== null &&
    cache.schema_version === EXTRACTION_CACHE_MANIFEST_VERSION &&
    cache.requested_turns !== undefined && cache.cached_turns !== undefined &&
    cache.coverage === 1 && cache.cached_turns >= cache.requested_turns &&
    hasCurrentRecallConfigIdentity(provenance.recall_config) &&
    hasRequiredEmbeddingArtifact(provenance.runtime) &&
    hasConsistentEmbeddingSupplementProvenance(provenance.runtime) &&
    (provenance.runtime.answer_rerank?.enabled !== true ||
      provenance.runtime.answer_rerank.model_artifact_sha256.length === 64) &&
    hasConsistentAnswerRerankProvenance(provenance.runtime);
}

function hasCurrentRecallConfigIdentity(
  config: LongMemEvalRunProvenance["recall_config"]
): boolean {
  return config.schema_version === EFFECTIVE_RECALL_CONFIG_SCHEMA_VERSION &&
    config.max_results !== undefined &&
    config.conflict_awareness !== undefined &&
    config.effective_config_sha256 !== undefined;
}

function hasRequiredEmbeddingArtifact(
  runtime: LongMemEvalRunProvenance["runtime"]
): boolean {
  const supplement = runtime.embedding_supplement;
  if (supplement?.enabled === true && supplement.provider_kind === "local_onnx") {
    return runtime.onnx_model_artifact_sha256 === supplement.model_artifact_sha256;
  }
  return runtime.onnx_model_artifact_sha256 === undefined;
}

function hasConsistentEmbeddingSupplementProvenance(
  runtime: LongMemEvalRunProvenance["runtime"]
): boolean {
  const pairedEnabled = readOptionalTreatmentBoolean(
    runtime.paired_env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT,
    "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT"
  );
  const d2qEnabled = readOptionalTreatmentBoolean(
    runtime.paired_env.ALAYA_RECALL_D2Q,
    "ALAYA_RECALL_D2Q"
  );
  const identity = runtime.embedding_supplement;
  if (identity === undefined) return false;
  if (pairedEnabled !== null && pairedEnabled !== identity.enabled) return false;
  if (identity.enabled !== (runtime.embedding_mode === "env")) return false;
  if (!identity.enabled) return true;
  if (identity.provider_kind !== runtime.embedding_provider_kind) return false;
  if (!runtime.embedding_provider_label.endsWith(`:${identity.effective_model_id}`)) return false;
  if (identity.provider_kind === "openai") return identity.d2q_input === "raw_content";
  return identity.d2q_input === (d2qEnabled === true ? "content_plus_hq" : "raw_content") &&
    runtime.onnx_model_artifact_sha256 === identity.model_artifact_sha256 &&
    (runtime.paired_env.ALAYA_LOCAL_EMBEDDING_MODEL === undefined ||
      runtime.paired_env.ALAYA_LOCAL_EMBEDDING_MODEL === identity.effective_model_id);
}

function hasConsistentAnswerRerankProvenance(
  runtime: LongMemEvalRunProvenance["runtime"]
): boolean {
  const pairedEnabled = readOptionalTreatmentBoolean(
    runtime.paired_env.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK,
    "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
  );
  if (runtime.answer_rerank === undefined) return false;
  return runtime.answer_rerank.enabled === (pairedEnabled ?? false);
}

async function readManifestIdentity(
  manifestPath: string | undefined
): Promise<LongMemEvalRunProvenance["question_manifest"]> {
  if (manifestPath === undefined) return null;
  const raw = await readFile(manifestPath, "utf8");
  const manifest = parseQuestionManifest(JSON.parse(raw) as unknown);
  return {
    ...questionManifestIdentity(manifest),
    file_sha256: createHash("sha256").update(raw, "utf8").digest("hex")
  };
}

async function readExtractionCacheIdentity(
  opts: LongMemEvalRunOptions,
  env: Readonly<Record<string, string | undefined>>
): Promise<LongMemEvalRunProvenance["extraction_cache"]> {
  const cacheRoot = opts.extractionCacheRoot ?? env.ALAYA_BENCH_EXTRACTION_CACHE_ROOT;
  if (cacheRoot === undefined || cacheRoot.trim().length === 0) return null;
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity === undefined) return null;
  const { manifest } = identity;
  return ExtractionCacheIdentitySchema.parse({
    manifest_sha256: identity.manifestSha256,
    ...manifest,
    provider_url: redactProvenanceUrl(manifest.provider_url),
    ...(manifest.archive_url === undefined
      ? {}
      : { archive_url: redactProvenanceUrl(manifest.archive_url) })
  });
}

export function collectPairedEnvironment(
  env: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> {
  const entries = Object.entries(env)
    .filter(([key, value]) => value !== undefined && isPairedEnvironmentKey(key))
    .map(([key, value]) => [key, redactPairedEnvironmentValue(value!)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function isPairedEnvironmentKey(key: string): boolean {
  return PAIRED_ENV_ALLOWLIST.has(key);
}

function redactPairedEnvironmentValue(value: string): string {
  return redactProvenanceUrl(value);
}

export function redactProvenanceUrl(value: string): string {
  if (!/(?:https?|wss?):\/\//iu.test(value)) return value;
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function readOptionalSha(raw: string | undefined, field: string): string | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  const value = raw.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${field} must be a SHA-256 hex digest`);
  return value;
}

function questionManifestIdentity(manifest: QuestionManifest) {
  return {
    schema_version: manifest.schema_version,
    variant: manifest.variant,
    dataset_sha256: manifest.dataset_sha256,
    algorithm_version: manifest.algorithm_version,
    target_count: manifest.target_count,
    selected_id_digest: manifest.selected_id_digest
  } as const;
}
