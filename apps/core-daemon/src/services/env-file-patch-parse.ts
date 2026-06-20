import { CoreError } from "@do-soul/alaya-core";
import {
  RuntimeEmbeddingConfigPatchSchema,
  RuntimeGardenComputeConfigPatchSchema,
  type RuntimeEmbeddingConfigPatch,
  type RuntimeGardenComputeConfigPatch
} from "@do-soul/alaya-protocol";

export type SecretRefMode = "env" | "file" | "paste";

export type RawRuntimeEmbeddingConfigPatch = RuntimeEmbeddingConfigPatch & {
  readonly secret_ref_mode?: SecretRefMode;
  readonly secret_value?: string | null;
};

export type RawRuntimeGardenComputeConfigPatch = RuntimeGardenComputeConfigPatch & {
  readonly secret_ref_mode?: SecretRefMode;
  readonly secret_value?: string | null;
};

export function parseRuntimeEmbeddingConfigPatchWithSecretControls(
  patch: unknown
): RawRuntimeEmbeddingConfigPatch {
  const { record, protocolPatch } = extractProtocolPatchRecord(
    patch,
    ["provider_url", "secret_ref", "model_id", "embedding_enabled", "secret_ref_mode", "secret_value"],
    "Invalid runtime embedding config patch",
    "Unknown runtime embedding config field"
  );
  const parsedProtocolPatch = RuntimeEmbeddingConfigPatchSchema.safeParse(protocolPatch);
  if (!parsedProtocolPatch.success) {
    throw new CoreError("VALIDATION", "Invalid runtime embedding config patch", {
      cause: parsedProtocolPatch.error
    });
  }
  return {
    ...parsedProtocolPatch.data,
    ...("secret_ref_mode" in record ? { secret_ref_mode: parseSecretRefMode(record.secret_ref_mode) } : {}),
    ...("secret_value" in record ? { secret_value: parseNullableRawString(record.secret_value, "secret_value") } : {})
  };
}

export function parseRuntimeGardenComputeConfigPatchWithSecretControls(
  patch: unknown
): RawRuntimeGardenComputeConfigPatch {
  const { record, protocolPatch } = extractProtocolPatchRecord(
    patch,
    ["provider_kind", "provider_url", "secret_ref", "model_id", "enabled", "secret_ref_mode", "secret_value"],
    "Invalid runtime garden compute config patch",
    "Unknown runtime garden compute config field"
  );
  const parsedProtocolPatch = RuntimeGardenComputeConfigPatchSchema.safeParse(protocolPatch);
  if (!parsedProtocolPatch.success) {
    throw new CoreError("VALIDATION", "Invalid runtime garden compute config patch", {
      cause: parsedProtocolPatch.error
    });
  }
  return {
    ...parsedProtocolPatch.data,
    ...("secret_ref_mode" in record ? { secret_ref_mode: parseSecretRefMode(record.secret_ref_mode) } : {}),
    ...("secret_value" in record ? { secret_value: parseNullableRawString(record.secret_value, "secret_value") } : {})
  };
}

function extractProtocolPatchRecord(
  patch: unknown,
  allowedKeys: readonly string[],
  validationMessage: string,
  unknownFieldPrefix: string
): Readonly<{ record: Record<string, unknown>; protocolPatch: Record<string, unknown> }> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new CoreError("VALIDATION", validationMessage);
  }
  const record = patch as Record<string, unknown>;
  const protocolPatch: Record<string, unknown> = {};
  const allowedKeySet = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowedKeySet.has(key)) {
      throw new CoreError("VALIDATION", `${unknownFieldPrefix}: ${key}`);
    }
    if (key !== "secret_ref_mode" && key !== "secret_value") {
      protocolPatch[key] = record[key];
    }
  }
  return { record, protocolPatch };
}

function parseNullableRawString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new CoreError("VALIDATION", `${field} must be a string or null`);
  }
  return value;
}

function parseSecretRefMode(value: unknown): SecretRefMode {
  if (value === "env" || value === "file" || value === "paste") {
    return value;
  }
  throw new CoreError("VALIDATION", "Invalid runtime embedding config patch");
}
