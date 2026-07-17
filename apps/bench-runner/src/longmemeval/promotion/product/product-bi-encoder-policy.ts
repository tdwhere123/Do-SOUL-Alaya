import { DEFAULT_LOCAL_ONNX_MODEL_ID } from "@do-soul/alaya-core";
import { readOptionalTreatmentBoolean } from
  "../../../harness/strict-treatment-config.js";

type BiEncoderSupplementIdentity = Readonly<{
  enabled: boolean;
  provider_kind?: string;
  effective_model_id?: string;
  model_artifact_sha256?: string;
  effective_schema_version?: number;
  d2q_input?: string;
}>;

export function assertProductDefaultBiEncoderEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  context: string
): void {
  const modelId = env.ALAYA_LOCAL_EMBEDDING_MODEL?.trim() ||
    DEFAULT_LOCAL_ONNX_MODEL_ID;
  const d2q = readOptionalTreatmentBoolean(
    env.ALAYA_RECALL_D2Q,
    "ALAYA_RECALL_D2Q"
  );
  if (modelId !== DEFAULT_LOCAL_ONNX_MODEL_ID || d2q === true ||
      env.ALAYA_LOCAL_ONNX_THREADS !== undefined) {
    throw new Error(`${context} differs from the product-default bi-encoder`);
  }
}

export function assertProductDefaultBiEncoderSupplement(
  identity: BiEncoderSupplementIdentity,
  context: string
): void {
  if (!identity.enabled || identity.provider_kind !== "local_onnx" ||
      identity.effective_model_id !== DEFAULT_LOCAL_ONNX_MODEL_ID ||
      identity.effective_schema_version !== 1 ||
      identity.d2q_input !== "raw_content" ||
      !/^[a-f0-9]{64}$/u.test(identity.model_artifact_sha256 ?? "")) {
    throw new Error(`${context} differs from the product-default bi-encoder identity`);
  }
}

export function assertProductDefaultBiEncoderRuntime(
  runtime: Readonly<{
    embedding_mode: string;
    embedding_provider_kind: string;
    embedding_provider_label: string;
    onnx_threads: number | null;
    embedding_supplement?: BiEncoderSupplementIdentity;
    answer_rerank?: Readonly<{ enabled: boolean }>;
  }>,
  context: string
): void {
  assertProductDefaultBiEncoderSupplement(
    runtime.embedding_supplement ?? { enabled: false },
    context
  );
  if (runtime.embedding_mode !== "env" ||
      runtime.embedding_provider_kind !== "local_onnx" ||
      runtime.embedding_provider_label !== `local_onnx:${DEFAULT_LOCAL_ONNX_MODEL_ID}` ||
      runtime.onnx_threads !== null ||
      runtime.answer_rerank?.enabled !== false) {
    throw new Error(`${context} differs from the product-default bi-encoder runtime`);
  }
}
