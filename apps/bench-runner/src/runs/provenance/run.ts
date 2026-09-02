import { createHash } from "node:crypto";
import type { EffectiveReconciliationBasis } from "@do-soul/alaya";
import { readFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import {
  readOptionalOnnxThreadCount
} from "../../harness/strict-treatment-config.js";
import { parseQuestionManifest, type QuestionManifest } from
  "../selection/question-manifest.js";
import type { LongMemEvalRunOptions } from "../../datasets/longmemeval/runner.js";
import {
  resolveEmbeddingSupplementRuntimeProvenance,
  resolveLocalCrossEncoderRuntimeProvenance
} from "./embedding/local-onnx.js";
import { DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND } from "../../harness/daemon/daemon-types.js";
import { buildEffectiveRecallConfigIdentity,
  type EffectiveRecallOptions } from "./effective-recall-config.js";
import {
  resolveFrozenCodeIdentity,
  type MeasuredGitState
} from "./contract/frozen-code-contract.js";
import {
  buildRecordedRunCodeIdentity,
  resolveMeasuredRunGitState
} from "./identity/run-code-identity.js";
import {
  collectPairedEnvironment,
  redactProvenanceUrl
} from "./paired-environment.js";
import type { LongMemEvalSelectionContractIdentity } from "../selection/contract.js";
import { computeExecutedDistIdentityFresh } from "./identity/executed-dist-identity.js";
import { readExtractionCacheIdentity } from "./identity/extraction-cache-identity.js";
import type { SourceAssertionSupplementBinding } from
  "../extraction/cache/semantic-supplement/source-assertion-supplement.js";
import { collectCjkSegmentationProvenance } from "./cjk-segmentation.js";
import { resolveBenchCheckoutRoot } from "./identity/checkout-root.js";
import {
  ExecutedDistIdentitySchema,
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "./run-provenance-schema.js";

export { collectPairedEnvironment, redactProvenanceUrl } from "./paired-environment.js";
export { computeExecutedDistIdentityFresh } from "./identity/executed-dist-identity.js";
export { assertRecordedRunCodeIdentity } from "./identity/run-code-identity.js";
export {
  LongMemEvalRunProvenanceObjectSchema,
  LongMemEvalRunProvenanceSchema,
  refineRunProvenanceIngestionMode,
  type LongMemEvalRunProvenance
} from "./run-provenance-schema.js";
export {
  isLongMemEvalRunProvenanceGateEligible,
  isLongMemEvalRunProvenanceSummaryGateEligible
} from "./run-provenance-gate.js";

export const LONGMEMEVAL_RUN_PROVENANCE_FILENAME = "longmemeval-run-provenance.json";

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
  readonly datasetSha256?: string;
  readonly selection?: LongMemEvalSelectionContractIdentity;
  readonly reconciliationBasis?: EffectiveReconciliationBasis;
  readonly semanticSupplement?: SourceAssertionSupplementBinding;
  readonly recordedGitState?: MeasuredGitState;
  readonly measureGitState?: (checkoutRoot: string) => Promise<MeasuredGitState>;
  readonly ingestionMode?: "precomputed_full" | "lazy_field";
  readonly semanticOverlayIdentity?: string;
}): Promise<LongMemEvalRunProvenance> {
  const checkoutRoot = resolveBenchCheckoutRoot();
  const [executedDist, frozenCode] = await Promise.all([
    resolveExecutedDistIdentity(input),
    resolveFrozenCodeIdentity({
      checkoutRoot,
      expectedCommitSha7: input.commitSha7,
      env: input.env
    })
  ]);
  const measuredGit = await resolveMeasuredRunGitState({
    frozen: frozenCode,
    checkoutRoot,
    recordedGitState: input.recordedGitState,
    measureGitState: input.measureGitState
  });
  const [extractionCache, questionManifest] = await Promise.all([
    readExtractionCacheIdentity(input.opts, input.env),
    readManifestIdentity(input.opts.questionManifest)
  ]);
  return LongMemEvalRunProvenanceSchema.parse({
    schema_version: input.ingestionMode === undefined ? 1 : 2,
    ...(input.ingestionMode === undefined ? {} : {
      ingestion_mode: input.ingestionMode,
      ...(input.semanticOverlayIdentity === undefined
        ? {}
        : { semantic_overlay_identity: input.semanticOverlayIdentity })
    }),
    ...(input.datasetSha256 === undefined
      ? {}
      : { dataset_sha256: input.datasetSha256 }),
    ...(input.selection === undefined ? {} : { selection: input.selection }),
    code: buildRecordedRunCodeIdentity({
      commitSha7: input.commitSha7,
      executedDist,
      frozen: frozenCode,
      measured: measuredGit
    }),
    extraction_cache: extractionCache,
    ...(input.semanticSupplement === undefined
      ? {}
      : { semantic_supplement: input.semanticSupplement }),
    runtime: await buildRuntimeIdentity(input),
    execution: buildExecutionIdentity(input),
    recall_config: buildRunRecallConfig(input),
    question_manifest: questionManifest
  });
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
  return {
    conf_slice_compatibility: false,
    ...buildEffectiveRecallConfigIdentity(input.env, input.recallOptions ?? {
      maxResults: 10,
      conflictAwareness: (input.opts.policyShape ?? "stress") !== "chat"
    })
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
    ...(input.reconciliationBasis === undefined
      ? {}
      : { reconciliation_basis: input.reconciliationBasis }),
    paired_env: collectPairedEnvironment(input.env),
    cjk_segmentation: collectCjkSegmentationProvenance()
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
