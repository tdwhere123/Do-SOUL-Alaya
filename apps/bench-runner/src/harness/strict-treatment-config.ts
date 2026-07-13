import { D2Q_SCHEMA_VERSION } from "@do-soul/alaya-core";

const RAW_EMBEDDING_SCHEMA_VERSION = 1;

export type TreatmentBooleanKey =
  | "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT"
  | "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
  | "ALAYA_RECALL_D2Q";

export function readOptionalTreatmentBoolean(
  raw: string | undefined,
  key: TreatmentBooleanKey
): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value.length === 0) return null;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${key} must be true, false, 1, or 0`);
}

export function readOptionalOnnxThreadCount(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  if (!/^\d+$/u.test(raw)) {
    throw new Error("ALAYA_LOCAL_ONNX_THREADS must be an integer from 1 to 64");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new Error("ALAYA_LOCAL_ONNX_THREADS must be an integer from 1 to 64");
  }
  return value;
}

export type EmbeddingInputIdentity = Readonly<{
  schema_version: number;
  d2q_input: "raw_content" | "content_plus_hq";
}>;

export function embeddingInputIdentityForSchemaVersion(
  schemaVersion: number
): EmbeddingInputIdentity {
  if (schemaVersion === D2Q_SCHEMA_VERSION) {
    return { schema_version: D2Q_SCHEMA_VERSION, d2q_input: "content_plus_hq" };
  }
  if (schemaVersion === RAW_EMBEDDING_SCHEMA_VERSION) {
    return { schema_version: RAW_EMBEDDING_SCHEMA_VERSION, d2q_input: "raw_content" };
  }
  throw new Error(`unsupported embedding schema version: ${schemaVersion}`);
}

export function resolveTreatmentEmbeddingInputIdentity(
  providerKind: "openai" | "local_onnx",
  env: Readonly<Record<string, string | undefined>>
): EmbeddingInputIdentity {
  const enabled = readOptionalTreatmentBoolean(env.ALAYA_RECALL_D2Q, "ALAYA_RECALL_D2Q");
  return embeddingInputIdentityForSchemaVersion(
    providerKind === "local_onnx" && enabled === true
      ? D2Q_SCHEMA_VERSION
      : RAW_EMBEDDING_SCHEMA_VERSION
  );
}
