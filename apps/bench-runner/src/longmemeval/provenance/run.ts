import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { parseRecallRuntimeConfigFromEnv } from "@do-soul/alaya-core";
import { z } from "zod";
import {
  parseQuestionManifest,
  type QuestionManifest
} from "../selection/question-manifest.js";
import type { LongMemEvalRunOptions } from "../runner.js";
import {
  extractionCacheManifestPath,
  readExtractionCacheManifest
} from "../extraction-cache-manifest.js";
import { resolveLocalOnnxArtifactSha256 } from "./local-onnx.js";

export const LONGMEMEVAL_RUN_PROVENANCE_FILENAME =
  "longmemeval-run-provenance.json";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const PAIRED_ENV_ALLOWLIST = new Set([
  "ALAYA_BENCH_ALLOW_LIVE_EXTRACTION",
  "ALAYA_BENCH_EXTRACTION_CACHE_MIN_COVERAGE",
  "ALAYA_CONFLICT_DETECTION_ENABLED",
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
  "ALAYA_RECALL_ANSWERS_WITH",
  "ALAYA_RECALL_COARSE_FLOOR",
  "ALAYA_RECALL_CONF_EVIDENCE_BETA",
  "ALAYA_RECALL_CONF_FLOOD_CAP",
  "ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL",
  "ALAYA_RECALL_CONF_RHO_EVIDENCE",
  "ALAYA_RECALL_CONF_RHO_PATH",
  "ALAYA_RECALL_CONF_W_PATH",
  "ALAYA_RECALL_COVERAGE_MIN_SCORE_RATIO",
  "ALAYA_RECALL_COVERAGE_POOL_K",
  "ALAYA_RECALL_COVERAGE_SELECTOR",
  "ALAYA_RECALL_COVERAGE_TARGET_K",
  "ALAYA_RECALL_DELIVERY_WINDOW",
  "ALAYA_RECALL_FUSION_RANK_FLOOR",
  "ALAYA_RECALL_FACET_TAGS",
  "ALAYA_RECALL_SOURCE_REF_ROBUST",
  "ALAYA_RECALL_STRUCTURAL_RESERVE",
  "OFFICIAL_API_GARDEN_MODEL"
]);

export const LongMemEvalRunProvenanceSchema = z.object({
  schema_version: z.literal(1),
  code: z.object({
    commit_sha7: z.string().regex(/^[a-f0-9]{7}$/u),
    gate_sha256: Sha256Schema.nullable(),
    worktree_state_sha256: Sha256Schema.nullable()
  }).strict(),
  extraction_cache: z.object({
    manifest_sha256: Sha256Schema,
    schema_version: z.number().int().positive(),
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
  }).strict().nullable(),
  runtime: z.object({
    node_version: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    embedding_mode: z.enum(["disabled", "env"]),
    embedding_provider_kind: z.enum(["openai", "local_onnx"]),
    embedding_provider_label: z.string().min(1),
    onnx_threads: z.number().int().positive().nullable(),
    onnx_model_artifact_sha256: Sha256Schema.optional(),
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
    conf_slice_compatibility: z.boolean()
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
  readonly runtime?: {
    readonly nodeVersion: string;
    readonly platform: string;
    readonly arch: string;
  };
}): Promise<LongMemEvalRunProvenance> {
  const recall = parseRecallRuntimeConfigFromEnv(input.env);
  return LongMemEvalRunProvenanceSchema.parse({
    schema_version: 1,
    code: {
      commit_sha7: input.commitSha7,
      gate_sha256: readOptionalSha(
        input.env.ALAYA_BENCH_GATE_SHA256,
        "ALAYA_BENCH_GATE_SHA256"
      ),
      worktree_state_sha256: readOptionalSha(
        input.env.ALAYA_BENCH_WORKTREE_STATE_SHA256,
        "ALAYA_BENCH_WORKTREE_STATE_SHA256"
      )
    },
    extraction_cache: await readExtractionCacheIdentity(input.opts, input.env),
    runtime: await buildRuntimeIdentity(input),
    execution: {
      protocol: "sequential",
      concurrency: 1,
      offset: input.opts.offset ?? 0,
      limit: input.opts.limit ?? null,
      evaluated_count: input.evaluatedCount
    },
    recall_config: {
      conf_slice_compatibility: recall.confSliceCompatibility
    },
    seed_capabilities: {
      facet_tags_enabled: /^(?:1|true|on|yes)$/iu.test(
        input.env.ALAYA_RECALL_FACET_TAGS ?? ""
      )
    },
    question_manifest: await readManifestIdentity(input.opts.questionManifest)
  });
}

async function buildRuntimeIdentity(
  input: Parameters<typeof buildLongMemEvalRunProvenance>[0]
): Promise<LongMemEvalRunProvenance["runtime"]> {
  const runtime = input.runtime ?? {
    nodeVersion: process.version,
    platform: platform(),
    arch: arch()
  };
  const onnxArtifactSha = await resolveLocalOnnxArtifactSha256(
    input.embeddingProviderLabel,
    input.env
  );
  return {
    node_version: runtime.nodeVersion,
    platform: runtime.platform,
    arch: runtime.arch,
    embedding_mode: input.opts.embeddingMode ?? "disabled",
    embedding_provider_kind: input.opts.embeddingProviderKind ?? "openai",
    embedding_provider_label: input.embeddingProviderLabel,
    onnx_threads: readOptionalPositiveInt(
      input.env.ALAYA_LOCAL_ONNX_THREADS,
      "ALAYA_LOCAL_ONNX_THREADS"
    ),
    ...(onnxArtifactSha === undefined
      ? {}
      : { onnx_model_artifact_sha256: onnxArtifactSha }),
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
  const manifest = readExtractionCacheManifest(cacheRoot);
  if (manifest === undefined) return null;
  const raw = await readFile(extractionCacheManifestPath(cacheRoot), "utf8");
  return {
    manifest_sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    ...manifest,
    provider_url: redactProvenanceUrl(manifest.provider_url),
    ...(manifest.archive_url === undefined
      ? {}
      : { archive_url: redactProvenanceUrl(manifest.archive_url) })
  };
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

function readOptionalPositiveInt(raw: string | undefined, field: string): number | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  if (!/^\d+$/u.test(raw)) throw new Error(`${field} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
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
