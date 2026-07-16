import { isDeepStrictEqual } from "node:util";
import { assertLongMemEvalTreatmentNeutralEdgeFormation } from
  "../edge-formation-config.js";
import type { LongMemEvalRunProvenance } from "../provenance/run.js";
import { assertProductFormationEnvironment } from
  "../product-formation-policy.js";
import { canonicalProductRecallProvenanceConfig } from
  "./product-policy-verifier.js";

const TREATMENT_NEUTRAL_RECALL_ENV = Object.freeze({
  ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false",
  ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "false"
});

export function assertPromotionSnapshotProducerPolicy(
  provenance: Pick<
    LongMemEvalRunProvenance,
    "runtime" | "recall_config" | "seed_capabilities"
  >
): void {
  assertTreatmentNeutralRuntime(provenance.runtime);
  assertTreatmentNeutralSnapshotEnvironment(provenance.runtime.paired_env);
  assertProductFormationEnvironment(
    provenance.runtime.paired_env,
    "snapshot producer product formation"
  );
  assertLongMemEvalTreatmentNeutralEdgeFormation(provenance.runtime.paired_env);
  if (!isDeepStrictEqual(
    provenance.recall_config,
    canonicalProductRecallProvenanceConfig()
  )) {
    throw new Error("snapshot producer recall config differs from the neutral contract");
  }
  if (provenance.seed_capabilities?.facet_tags_enabled !== false) {
    throw new Error("snapshot producer seed capabilities differ from the neutral contract");
  }
}

function assertTreatmentNeutralRuntime(
  runtime: LongMemEvalRunProvenance["runtime"]
): void {
  if (runtime.embedding_mode !== "disabled" ||
      runtime.embedding_provider_kind !== "local_onnx" ||
      runtime.embedding_provider_label !== "none" ||
      runtime.onnx_threads !== null ||
      runtime.onnx_model_artifact_sha256 !== undefined ||
      runtime.embedding_supplement?.enabled !== false ||
      runtime.answer_rerank?.enabled !== false) {
    throw new Error("snapshot producer runtime is not treatment-neutral");
  }
}

function assertTreatmentNeutralSnapshotEnvironment(
  env: Readonly<Record<string, string>>
): void {
  for (const [key, expected] of Object.entries(TREATMENT_NEUTRAL_RECALL_ENV)) {
    if (env[key] !== expected) {
      throw new Error(`snapshot producer requires ${key}=${expected}`);
    }
  }
}
