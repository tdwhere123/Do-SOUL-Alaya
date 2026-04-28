import {
  assertIsoDatetime,
  assertObject,
  assertOneOf,
  assertText
} from "../foundation/validation.js";
import type { SecretResolutionStatus } from "../secrets/index.js";
import { providerHealthStatuses, type ProviderRegistryEntry } from "./index.js";

export const providerStatusStates = [
  "missing",
  "configured",
  "enabled",
  "disabled",
  "unavailable",
  "degraded"
] as const;
export type ProviderStatusState = (typeof providerStatusStates)[number];

export const embeddingEffectiveModes = ["keyword_only", "embedding_supplement", "degraded"] as const;
export type EmbeddingEffectiveMode = (typeof embeddingEffectiveModes)[number];

export interface ProviderStatusAuditContext {
  readonly secret_ref?: string;
  readonly secret_source_type?: string;
  readonly secret_state?: string;
  readonly reason?: string;
}

export interface ProviderStatusReport {
  readonly provider_id: string | null;
  readonly provider_kind: string | null;
  readonly model_id: string | null;
  readonly config_ref: string | null;
  readonly status: ProviderStatusState;
  readonly provider_configured: boolean;
  readonly provider_enabled: boolean;
  readonly reason: string | null;
  readonly degraded_reason: string | null;
  readonly checked_at: string;
  readonly audit_context: ProviderStatusAuditContext | null;
}

export interface DeriveProviderStatusInput {
  readonly provider: ProviderRegistryEntry | null;
  readonly secret_resolution?: SecretResolutionStatus | null;
  readonly checked_at: string;
}

export interface EmbeddingStatusReport {
  readonly workspace_id: string;
  readonly embedding_enabled: boolean;
  readonly provider_configured: boolean;
  readonly provider_status: ProviderStatusState;
  readonly model_id: string | null;
  readonly storage_available: boolean;
  readonly effective_mode: EmbeddingEffectiveMode;
  readonly degraded_reason: string | null;
  readonly checked_at: string;
  readonly audit_context: ProviderStatusAuditContext | null;
}

export interface DeriveEmbeddingStatusInput {
  readonly workspace_id: string;
  readonly provider: ProviderStatusReport;
  readonly embedding_enabled: boolean;
  readonly recall_policy_embedding_enabled?: boolean;
  readonly storage_available: boolean;
  readonly degradation_reason?: string | null;
  readonly checked_at: string;
}

export function deriveProviderStatus(input: DeriveProviderStatusInput): ProviderStatusReport {
  assertObject(input, "DeriveProviderStatusInput");
  assertIsoDatetime(input.checked_at, "checked_at");

  if (input.provider === null) {
    return providerStatus({
      checked_at: input.checked_at,
      provider: null,
      provider_configured: false,
      provider_enabled: false,
      reason: "provider_missing",
      status: "missing"
    });
  }

  const provider = input.provider;
  validateProviderSummary(provider);
  const secretFailure = secretFailureContext(input.secret_resolution ?? null);

  if (provider.health.status === "enabled" && secretFailure !== null) {
    return providerStatus({
      audit_context: secretFailure.audit_context,
      checked_at: input.checked_at,
      degraded_reason: secretFailure.degraded_reason,
      provider,
      provider_configured: true,
      provider_enabled: false,
      reason: secretFailure.degraded_reason,
      status: "degraded"
    });
  }

  switch (provider.health.status) {
    case "enabled":
      return providerStatus({
        checked_at: input.checked_at,
        provider,
        provider_configured: true,
        provider_enabled: true,
        reason: null,
        status: "enabled"
      });
    case "configured":
      return providerStatus({
        checked_at: input.checked_at,
        provider,
        provider_configured: true,
        provider_enabled: false,
        reason: normalizeReason(provider.health.reason) ?? "provider_configured_not_enabled",
        status: "configured"
      });
    case "disabled":
      return providerStatus({
        checked_at: input.checked_at,
        provider,
        provider_configured: true,
        provider_enabled: false,
        reason: normalizeReason(provider.health.reason) ?? "provider_disabled",
        status: "disabled"
      });
    case "unavailable":
      return providerStatus({
        checked_at: input.checked_at,
        provider,
        provider_configured: true,
        provider_enabled: false,
        reason: normalizeReason(provider.health.reason) ?? "provider_unavailable",
        status: "unavailable"
      });
    case "degraded": {
      const reason = requireReason(provider.health.reason, "degraded provider status requires reason.");
      return providerStatus({
        checked_at: input.checked_at,
        degraded_reason: reason,
        provider,
        provider_configured: true,
        provider_enabled: false,
        reason,
        status: "degraded"
      });
    }
  }
}

export function deriveEmbeddingStatus(input: DeriveEmbeddingStatusInput): EmbeddingStatusReport {
  assertObject(input, "DeriveEmbeddingStatusInput");
  assertText(input.workspace_id, "workspace_id");
  assertIsoDatetime(input.checked_at, "checked_at");
  assertProviderStatusReport(input.provider);
  assertBoolean(input.embedding_enabled, "embedding_enabled");
  assertBoolean(input.storage_available, "storage_available");
  if (
    input.recall_policy_embedding_enabled !== undefined &&
    typeof input.recall_policy_embedding_enabled !== "boolean"
  ) {
    throw new TypeError("recall_policy_embedding_enabled must be boolean.");
  }

  const effectiveEmbeddingEnabled = input.embedding_enabled && input.recall_policy_embedding_enabled === true;
  if (!effectiveEmbeddingEnabled) {
    return embeddingStatus(input, false, "keyword_only", null);
  }

  if (input.provider.status === "missing") {
    return embeddingStatus(input, true, "degraded", "provider_unconfigured");
  }
  if (input.provider.status === "configured") {
    return embeddingStatus(input, true, "degraded", "provider_configured_not_enabled");
  }
  if (input.provider.status === "disabled") {
    return embeddingStatus(input, true, "degraded", input.provider.reason ?? "provider_disabled");
  }
  if (input.provider.status === "unavailable") {
    return embeddingStatus(input, true, "degraded", input.provider.reason ?? "provider_unavailable");
  }
  if (input.provider.status === "degraded") {
    return embeddingStatus(
      input,
      true,
      "degraded",
      requireReason(input.provider.degraded_reason, "degraded provider status requires reason.")
    );
  }
  if (!input.storage_available) {
    return embeddingStatus(input, true, "degraded", "storage_unavailable");
  }

  const runtimeDegradationReason = normalizeReason(input.degradation_reason);
  if (input.degradation_reason !== undefined && runtimeDegradationReason === null) {
    throw new TypeError("degraded embedding status requires reason.");
  }
  if (runtimeDegradationReason !== null) {
    return embeddingStatus(input, true, "degraded", runtimeDegradationReason);
  }

  return embeddingStatus(input, true, "embedding_supplement", null);
}

function providerStatus(input: {
  readonly provider: ProviderRegistryEntry | null;
  readonly status: ProviderStatusState;
  readonly provider_configured: boolean;
  readonly provider_enabled: boolean;
  readonly reason: string | null;
  readonly degraded_reason?: string | null;
  readonly checked_at: string;
  readonly audit_context?: ProviderStatusAuditContext | null;
}): ProviderStatusReport {
  const degradedReason = input.degraded_reason ?? null;
  if (input.status === "degraded" && normalizeReason(degradedReason) === null) {
    throw new TypeError("degraded provider status requires reason.");
  }
  if (input.status !== "degraded" && degradedReason !== null) {
    throw new TypeError("degraded_reason is only allowed for degraded provider status.");
  }

  return {
    audit_context: input.audit_context ?? null,
    checked_at: input.checked_at,
    config_ref: input.provider?.config_ref ?? null,
    degraded_reason: degradedReason,
    model_id: normalizeReason(input.provider?.model_ref ?? null),
    provider_configured: input.provider_configured,
    provider_enabled: input.provider_enabled,
    provider_id: input.provider?.provider_id ?? null,
    provider_kind: input.provider?.provider_kind ?? null,
    reason: input.reason,
    status: input.status
  };
}

function embeddingStatus(
  input: DeriveEmbeddingStatusInput,
  embeddingEnabled: boolean,
  effectiveMode: EmbeddingEffectiveMode,
  degradedReason: string | null
): EmbeddingStatusReport {
  if (effectiveMode === "degraded" && normalizeReason(degradedReason) === null) {
    throw new TypeError("degraded embedding status requires reason.");
  }
  if (effectiveMode !== "degraded" && degradedReason !== null) {
    throw new TypeError("degraded_reason is only allowed for degraded embedding status.");
  }
  if (!embeddingEnabled && effectiveMode !== "keyword_only") {
    throw new TypeError("disabled embeddings must use keyword_only effective_mode.");
  }

  return {
    audit_context: effectiveMode === "degraded" ? input.provider.audit_context : null,
    checked_at: input.checked_at,
    degraded_reason: degradedReason,
    effective_mode: effectiveMode,
    embedding_enabled: embeddingEnabled,
    model_id: input.provider.model_id,
    provider_configured: input.provider.provider_configured,
    provider_status: input.provider.status,
    storage_available: input.storage_available,
    workspace_id: input.workspace_id
  };
}

function secretFailureContext(
  secretResolution: SecretResolutionStatus | null
): { readonly degraded_reason: string; readonly audit_context: ProviderStatusAuditContext } | null {
  if (secretResolution === null || secretResolution.resolved) {
    return null;
  }
  assertSecretResolutionStatus(secretResolution);
  return {
    audit_context: {
      reason: secretResolution.reason ?? secretResolution.state,
      secret_ref: secretResolution.secret_ref,
      secret_source_type: secretResolution.source_type,
      secret_state: secretResolution.state
    },
    degraded_reason: `secret_ref_${secretResolution.state}:${secretResolution.secret_ref}`
  };
}

function validateProviderSummary(provider: ProviderRegistryEntry): void {
  assertObject(provider, "ProviderRegistryEntry");
  assertText(provider.provider_id, "provider_id");
  assertText(provider.provider_kind, "provider_kind");
  assertText(provider.model_ref, "model_ref");
  assertText(provider.config_ref, "config_ref");
  assertObject(provider.health, "health");
  assertOneOf(provider.health.status, providerHealthStatuses, "health.status");
  if (provider.health.checked_at !== null) {
    assertIsoDatetime(provider.health.checked_at, "health.checked_at");
  }
}

function assertProviderStatusReport(report: ProviderStatusReport): void {
  assertObject(report, "ProviderStatusReport");
  assertText(report.status, "provider.status");
  assertIsoDatetime(report.checked_at, "provider.checked_at");
  assertBoolean(report.provider_configured, "provider_configured");
  assertBoolean(report.provider_enabled, "provider_enabled");
  if (report.status === "degraded") {
    requireReason(report.degraded_reason, "degraded provider status requires reason.");
  }
}

function assertSecretResolutionStatus(status: SecretResolutionStatus): void {
  assertObject(status, "SecretResolutionStatus");
  assertText(status.secret_ref, "secret_ref");
  assertText(status.source_type, "source_type");
  assertText(status.source_key, "source_key");
  assertText(status.state, "state");
  assertBoolean(status.resolved, "resolved");
  assertIsoDatetime(status.checked_at, "checked_at");
}

function requireReason(reason: string | null | undefined, message: string): string {
  const normalized = normalizeReason(reason);
  if (normalized === null) {
    throw new TypeError(message);
  }
  return normalized;
}

function normalizeReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) {
    return null;
  }
  const trimmed = reason.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be boolean.`);
  }
}
