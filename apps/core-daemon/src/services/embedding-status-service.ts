import {
  EmbeddingStatusSchema,
  HealthEventKind,
  type EmbeddingStatus,
  type HealthJournalEntry
} from "@do-soul/alaya-protocol";

const DEFAULT_DEGRADATION_LOOKBACK_MS = 15 * 60 * 1000;
const DEGRADATION_EVENT_LIMIT = 10;

export interface EmbeddingStatusService {
  getStatus(workspaceId: string): Promise<EmbeddingStatus>;
}

export interface EmbeddingStatusDegradationSource {
  getRecentEvents(
    workspaceId: string,
    params: {
      readonly kind: typeof HealthEventKind.EMBEDDING_SUPPLEMENT;
      readonly limit: number;
    }
  ): Promise<readonly Pick<HealthJournalEntry, "created_at" | "detail_json">[]>;
}

export interface EmbeddingStatusServiceOptions {
  readonly embeddingEnabled: boolean;
  readonly recallPolicyEmbeddingEnabled?: boolean;
  readonly providerConfigured: boolean;
  readonly modelId: string | null;
  readonly storageAvailable: boolean;
  readonly degradationSource?: EmbeddingStatusDegradationSource;
  readonly degradationLookbackMs?: number;
  readonly now?: () => string;
}

export function createEmbeddingStatusService(
  options: EmbeddingStatusServiceOptions
): EmbeddingStatusService {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    getStatus: async (workspaceId: string): Promise<EmbeddingStatus> => {
      const checkedAt = now();
      const effectiveEmbeddingEnabled = isEffectiveEmbeddingEnabled(options);
      const recentDegradedReason = await findRecentDegradedReason(
        workspaceId,
        options,
        effectiveEmbeddingEnabled,
        checkedAt
      );

      return EmbeddingStatusSchema.parse({
        workspace_id: workspaceId,
        embedding_enabled: effectiveEmbeddingEnabled,
        provider_configured: options.providerConfigured,
        model_id: normalizeModelId(options.modelId),
        storage_available: options.storageAvailable,
        ...resolveEffectivePosture(options, effectiveEmbeddingEnabled, recentDegradedReason),
        checked_at: checkedAt
      });
    }
  };
}

function isEffectiveEmbeddingEnabled(options: EmbeddingStatusServiceOptions): boolean {
  return options.embeddingEnabled && options.recallPolicyEmbeddingEnabled === true;
}

function resolveEffectivePosture(
  options: EmbeddingStatusServiceOptions,
  effectiveEmbeddingEnabled: boolean,
  recentDegradedReason: string | null
): Pick<EmbeddingStatus, "effective_mode" | "degraded_reason"> {
  if (!effectiveEmbeddingEnabled) {
    return {
      effective_mode: "keyword_only",
      degraded_reason: null
    };
  }

  if (!options.providerConfigured) {
    return {
      effective_mode: "degraded",
      degraded_reason: "provider_unconfigured"
    };
  }

  if (!options.storageAvailable) {
    return {
      effective_mode: "degraded",
      degraded_reason: "storage_unavailable"
    };
  }

  if (recentDegradedReason !== null) {
    return {
      effective_mode: "degraded",
      degraded_reason: recentDegradedReason
    };
  }

  return {
    effective_mode: "embedding_supplement",
    degraded_reason: null
  };
}

async function findRecentDegradedReason(
  workspaceId: string,
  options: EmbeddingStatusServiceOptions,
  effectiveEmbeddingEnabled: boolean,
  checkedAt: string
): Promise<string | null> {
  if (
    !effectiveEmbeddingEnabled ||
    !options.providerConfigured ||
    !options.storageAvailable ||
    options.degradationSource === undefined
  ) {
    return null;
  }

  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    return null;
  }

  const lookbackMs = options.degradationLookbackMs ?? DEFAULT_DEGRADATION_LOOKBACK_MS;
  const entries = await options.degradationSource.getRecentEvents(workspaceId, {
    kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
    limit: DEGRADATION_EVENT_LIMIT
  });

  for (const entry of entries) {
    const reason = extractDegradedReason(entry.detail_json);
    if (reason === null) {
      continue;
    }

    const createdAtMs = Date.parse(entry.created_at);
    const ageMs = checkedAtMs - createdAtMs;
    if (Number.isFinite(createdAtMs) && ageMs >= 0 && ageMs <= lookbackMs) {
      return reason;
    }
  }

  return null;
}

function extractDegradedReason(detailJson: Record<string, unknown>): string | null {
  const value = detailJson.reason ?? detailJson.degradation_reason;
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeModelId(modelId: string | null): string | null {
  const trimmed = modelId?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
