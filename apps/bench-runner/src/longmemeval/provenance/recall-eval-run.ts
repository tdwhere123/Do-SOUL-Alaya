import { parseRecallRuntimeConfigFromEnv } from "@do-soul/alaya-core";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RecallEvalRuntimeAttribution } from "../lifecycle/recall-eval-runtime.js";
import type { LongMemEvalSnapshotManifest } from "../snapshot.js";
import {
  collectPairedEnvironment,
  LONGMEMEVAL_RUN_PROVENANCE_FILENAME,
  LongMemEvalRunProvenanceSchema,
  readOptionalSha,
  renderLongMemEvalRunProvenance,
  type LongMemEvalRunProvenance
} from "./run.js";

export function buildRecallEvalRunProvenance(input: {
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly runtimeAttribution: RecallEvalRuntimeAttribution;
  readonly evaluatedCount: number;
  readonly offset: number;
  readonly limit: number | null;
  readonly commitSha7: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): LongMemEvalRunProvenance {
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
    extraction_cache: input.manifest.run_provenance?.extraction_cache ?? null,
    runtime: buildCurrentRuntime(input.runtimeAttribution, input.env),
    execution: {
      protocol: "sequential",
      concurrency: 1,
      offset: input.offset,
      limit: input.limit,
      evaluated_count: input.evaluatedCount
    },
    recall_config: {
      conf_slice_compatibility: recall.confSliceCompatibility
    },
    ...(input.manifest.run_provenance?.seed_capabilities === undefined
      ? {}
      : { seed_capabilities: input.manifest.run_provenance.seed_capabilities }),
    question_manifest: input.manifest.run_provenance?.question_manifest ?? null
  });
}

export async function writeRecallEvalRunProvenance(
  archiveRoot: string,
  input: Parameters<typeof buildRecallEvalRunProvenance>[0]
): Promise<void> {
  await writeFile(
    join(archiveRoot, LONGMEMEVAL_RUN_PROVENANCE_FILENAME),
    renderLongMemEvalRunProvenance(buildRecallEvalRunProvenance(input)),
    "utf8"
  );
}

function buildCurrentRuntime(
  attribution: RecallEvalRuntimeAttribution,
  env: Readonly<Record<string, string | undefined>>
): LongMemEvalRunProvenance["runtime"] {
  return {
    node_version: attribution.node_version,
    platform: attribution.platform,
    arch: attribution.arch,
    embedding_mode: attribution.embedding_mode,
    embedding_provider_kind: attribution.embedding_provider_kind,
    embedding_provider_label: attribution.embedding_provider_label,
    onnx_threads: attribution.onnx_threads,
    ...(attribution.onnx_model_artifact_sha256 === null
      ? {}
      : { onnx_model_artifact_sha256: attribution.onnx_model_artifact_sha256 }),
    paired_env: collectPairedEnvironment(env)
  };
}
