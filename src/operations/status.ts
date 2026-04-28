import {
  assertIsoDatetime,
  assertObject,
  assertText
} from "../foundation/validation.js";
import { AlayaValidationError } from "../runtime/audit-types.js";
import type {
  CreateOperationsStatusInput,
  OperationsEmbeddingStatus,
  OperationsProviderStatusInput,
  OperationsSecretRefReport,
  OperationsSecretRefStatus,
  OperationsStatusReport,
  ProviderPosture
} from "./types.js";

export function createOperationsStatusReport(input: CreateOperationsStatusInput): OperationsStatusReport {
  validateStatusInput(input);
  const providerPosture = deriveProviderPosture(input.provider);
  const embedding = deriveEmbeddingStatus(input.provider);
  const degradedReasons = collectDegradedReasons(input, providerPosture, embedding);

  return {
    schema_version: 1,
    checked_at: input.checked_at,
    read_only: true,
    durable_truth_written: false,
    mutation_count: 0,
    local_data_path: {
      source: input.local_data_path.source,
      path_ref: input.local_data_path.path_ref
    },
    storage: {
      ...input.storage,
      status: input.storage.ready ? "ok" : "failed"
    },
    profile: {
      ...input.profile,
      status: input.profile.ready ? "ok" : "failed"
    },
    provider: {
      provider_id: input.provider.provider_id,
      posture: providerPosture,
      embedding,
      secret_refs: input.provider.secret_refs.map(sanitizeSecretRef)
    },
    attachments: {
      mcp: input.attachments.mcp,
      cli: input.attachments.cli
    },
    host_prereqs: input.host_prereqs.map((prereq) => ({ ...prereq })),
    backup: {
      export_ready: input.backup.export_ready,
      backup_ready: input.backup.backup_ready,
      last_backup_id: input.backup.last_backup_id
    },
    degraded_reasons: degradedReasons
  };
}

export function deriveProviderPosture(input: Pick<
  OperationsProviderStatusInput,
  "provider_configured" | "enabled" | "storage_available"
> & Partial<Pick<
  OperationsProviderStatusInput,
  "disabled_reason" | "degraded_reason" | "secret_refs"
>>): ProviderPosture {
  if (!input.provider_configured) {
    return "missing";
  }
  if (hasText(input.disabled_reason)) {
    return "disabled";
  }
  if (input.enabled !== true) {
    return "configured";
  }
  if (input.storage_available !== true) {
    return "unavailable";
  }
  if (hasText(input.degraded_reason) || hasUnavailableSecretRef(input.secret_refs ?? [])) {
    return "degraded";
  }
  return "enabled";
}

function deriveEmbeddingStatus(input: OperationsProviderStatusInput): OperationsEmbeddingStatus {
  const embeddingEnabled = input.enabled === true;
  if (!embeddingEnabled) {
    return {
      embedding_enabled: false,
      provider_configured: input.provider_configured,
      model_ref: normalizeModelRef(input.model_ref),
      storage_available: input.storage_available,
      effective_mode: "keyword_only",
      degraded_reason: null
    };
  }

  const degradedReason = providerDegradedReason(input);
  if (degradedReason !== null) {
    return {
      embedding_enabled: true,
      provider_configured: input.provider_configured,
      model_ref: normalizeModelRef(input.model_ref),
      storage_available: input.storage_available,
      effective_mode: "degraded",
      degraded_reason: degradedReason
    };
  }

  return {
    embedding_enabled: true,
    provider_configured: input.provider_configured,
    model_ref: normalizeModelRef(input.model_ref),
    storage_available: input.storage_available,
    effective_mode: "embedding_supplement",
    degraded_reason: null
  };
}

function providerDegradedReason(input: OperationsProviderStatusInput): string | null {
  if (!input.provider_configured) {
    return "provider_unconfigured";
  }
  if (!input.storage_available) {
    return "storage_unavailable";
  }
  const unavailableSecret = input.secret_refs.find((secret) => secret.resolution_state !== "available");
  if (unavailableSecret !== undefined) {
    return unavailableSecret.error_code ?? `secret_ref_${unavailableSecret.resolution_state}`;
  }
  return normalizeText(input.degraded_reason);
}

function sanitizeSecretRef(secretRef: OperationsSecretRefStatus): OperationsSecretRefReport {
  return {
    secret_ref: secretRef.secret_ref,
    source_type: secretRef.source_type,
    resolution_state: secretRef.resolution_state,
    error_code: secretRef.error_code ?? null
  };
}

function validateStatusInput(input: CreateOperationsStatusInput): void {
  assertObject(input, "OperationsStatusInput");
  assertIsoDatetime(input.checked_at, "checked_at");
  assertObject(input.local_data_path, "local_data_path");
  if (
    input.local_data_path.source !== "DATA_DIR" &&
    input.local_data_path.source !== "default" &&
    input.local_data_path.source !== "explicit"
  ) {
    throw new AlayaValidationError("local_data_path.source is not supported.");
  }
  assertText(input.local_data_path.path_ref, "local_data_path.path_ref");

  assertObject(input.storage, "storage");
  if (input.storage.driver !== "node:sqlite" && input.storage.driver !== "unknown") {
    throw new AlayaValidationError("storage.driver is not supported.");
  }
  if (typeof input.storage.ready !== "boolean") {
    throw new AlayaValidationError("storage.ready must be boolean.");
  }
  if (input.storage.database_state !== "initialized" && input.storage.database_state !== "unavailable") {
    throw new AlayaValidationError("storage.database_state is not supported.");
  }

  assertObject(input.profile, "profile");
  if (typeof input.profile.ready !== "boolean") {
    throw new AlayaValidationError("profile.ready must be boolean.");
  }
  input.profile.scopes.forEach((scope, index) => {
    assertObject(scope, `profile.scopes[${index}]`);
    assertText(scope.scope_id, `profile.scopes[${index}].scope_id`);
    if (scope.scope_kind !== "user" && scope.scope_kind !== "project") {
      throw new AlayaValidationError(`profile.scopes[${index}].scope_kind is not supported.`);
    }
    if (typeof scope.ready !== "boolean") {
      throw new AlayaValidationError(`profile.scopes[${index}].ready must be boolean.`);
    }
  });

  validateProvider(input.provider);
  validateAttachment(input.attachments.mcp, "attachments.mcp");
  validateAttachment(input.attachments.cli, "attachments.cli");
  input.host_prereqs.forEach((prereq, index) => {
    assertObject(prereq, `host_prereqs[${index}]`);
    assertText(prereq.name, `host_prereqs[${index}].name`);
    if (typeof prereq.required !== "boolean") {
      throw new AlayaValidationError(`host_prereqs[${index}].required must be boolean.`);
    }
    if (typeof prereq.available !== "boolean") {
      throw new AlayaValidationError(`host_prereqs[${index}].available must be boolean.`);
    }
    if (prereq.reason !== undefined && prereq.reason !== null) {
      assertText(prereq.reason, `host_prereqs[${index}].reason`);
    }
  });

  if (typeof input.backup.export_ready !== "boolean" || typeof input.backup.backup_ready !== "boolean") {
    throw new AlayaValidationError("backup readiness values must be boolean.");
  }
  if (input.backup.last_backup_id !== null) {
    assertText(input.backup.last_backup_id, "backup.last_backup_id");
  }
}

function validateProvider(provider: OperationsProviderStatusInput): void {
  assertObject(provider, "provider");
  if (provider.provider_id !== null) {
    assertText(provider.provider_id, "provider.provider_id");
  }
  if (typeof provider.provider_configured !== "boolean") {
    throw new AlayaValidationError("provider.provider_configured must be boolean.");
  }
  if (provider.provider_configured && provider.provider_id === null) {
    throw new AlayaValidationError("configured provider requires provider_id.");
  }
  if (!provider.provider_configured && provider.provider_id !== null) {
    throw new AlayaValidationError("missing provider must not invent provider_id.");
  }
  if (provider.model_ref !== null) {
    assertText(provider.model_ref, "provider.model_ref");
  }
  if (typeof provider.enabled !== "boolean") {
    throw new AlayaValidationError("provider.enabled must be boolean.");
  }
  if (typeof provider.storage_available !== "boolean") {
    throw new AlayaValidationError("provider.storage_available must be boolean.");
  }
  if (provider.disabled_reason !== undefined && provider.disabled_reason !== null) {
    assertText(provider.disabled_reason, "provider.disabled_reason");
  }
  if (provider.degraded_reason !== undefined && provider.degraded_reason !== null) {
    assertText(provider.degraded_reason, "provider.degraded_reason");
  }
  provider.secret_refs.forEach((secretRef, index) => {
    assertObject(secretRef, `provider.secret_refs[${index}]`);
    assertText(secretRef.secret_ref, `provider.secret_refs[${index}].secret_ref`);
    if (secretRef.source_type !== "env" && secretRef.source_type !== "local_file" && secretRef.source_type !== "external") {
      throw new AlayaValidationError(`provider.secret_refs[${index}].source_type is not supported.`);
    }
    if (
      secretRef.resolution_state !== "available" &&
      secretRef.resolution_state !== "missing" &&
      secretRef.resolution_state !== "failed" &&
      secretRef.resolution_state !== "unresolved"
    ) {
      throw new AlayaValidationError(`provider.secret_refs[${index}].resolution_state is not supported.`);
    }
    if (secretRef.error_code !== undefined && secretRef.error_code !== null) {
      assertText(secretRef.error_code, `provider.secret_refs[${index}].error_code`);
    }
  });
}

function validateAttachment(value: string, label: string): void {
  if (
    value !== "available" &&
    value !== "attached" &&
    value !== "not_attached" &&
    value !== "failed" &&
    value !== "not_implemented"
  ) {
    throw new AlayaValidationError(`${label} is not supported.`);
  }
}

function collectDegradedReasons(
  input: CreateOperationsStatusInput,
  posture: ProviderPosture,
  embedding: OperationsEmbeddingStatus
): readonly string[] {
  const reasons: string[] = [];
  if (!input.storage.ready) {
    reasons.push("storage_unavailable");
  }
  if (!input.profile.ready) {
    reasons.push("profile_unavailable");
  }
  if (posture === "disabled" && hasText(input.provider.disabled_reason)) {
    reasons.push(input.provider.disabled_reason);
  }
  if (posture === "degraded" && embedding.degraded_reason !== null) {
    reasons.push(embedding.degraded_reason);
  }
  for (const prereq of input.host_prereqs) {
    if (prereq.required && !prereq.available) {
      reasons.push(prereq.reason ?? `missing_host_prereq:${prereq.name}`);
    }
  }
  return reasons;
}

function hasUnavailableSecretRef(secretRefs: readonly OperationsSecretRefStatus[]): boolean {
  return secretRefs.some((secretRef) => secretRef.resolution_state !== "available");
}

function normalizeModelRef(value: string | null): string | null {
  return normalizeText(value);
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function hasText(value: string | null | undefined): value is string {
  return normalizeText(value) !== null;
}
