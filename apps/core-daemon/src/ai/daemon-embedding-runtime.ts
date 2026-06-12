import {
  EmbeddingBackfillHandler,
  EmbeddingRecallService,
  LocalOnnxEmbeddingClient,
  OpenAIEmbeddingClient,
  defaultLocalOnnxCacheDir,
  type EmbeddingProviderPort,
  type EmbeddingRecallEventLogPort,
  type EmbeddingRecallServiceDependencies
} from "@do-soul/alaya-core";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import type { SqliteMemoryEntryRepo, StorageDatabase } from "@do-soul/alaya-storage";
import {
  createEmbeddingStatusService,
  type EmbeddingStatusDegradationSource
} from "../services/embedding-status-service.js";
import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  createOptionalMemoryEmbeddingRepo,
  readConfigEnvValue,
  readNonEmptyEnv
} from "../runtime/index.js";
import { resolveSecretRef, type ResolveSecretError } from "../secrets/index.js";

export function createDaemonEmbeddingRuntime(input: {
  readonly database: StorageDatabase;
  readonly configEnv: ReadonlyMap<string, string>;
  readonly eventLogRepo: EmbeddingRecallEventLogPort;
  readonly healthJournalService: EmbeddingStatusDegradationSource &
    NonNullable<EmbeddingRecallServiceDependencies["healthJournalRecorder"]>;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly embeddingProviderOverride?: EmbeddingProviderPort | null;
}) {
  const memoryEmbeddingRepo = createOptionalMemoryEmbeddingRepo(input.database);
  const rawEmbeddingSecretRef = readConfigEnvValue(input.configEnv, "ALAYA_OPENAI_SECRET_REF");
  const embeddingApiKey = resolveOptionalEmbeddingApiKey(rawEmbeddingSecretRef, input.warn);
  const configuredEmbeddingModel = readNonEmptyEnv(readConfigEnvValue(input.configEnv, "OPENAI_EMBEDDING_MODEL"));
  const configuredEmbeddingProviderUrl = readNonEmptyEnv(
    readConfigEnvValue(input.configEnv, "OPENAI_EMBEDDING_PROVIDER_URL")
  );
  // Provider selection: "openai" (default) reaches an API embedding endpoint;
  // "local_onnx" runs an on-device ONNX model with no network dependency.
  // Vectors are isolated by provider_kind + model_id at recall read time, so
  // switching providers re-backfills rather than mixing cosine spaces.
  const embeddingProviderKind =
    readNonEmptyEnv(readConfigEnvValue(input.configEnv, "ALAYA_EMBEDDING_PROVIDER")) === "local_onnx"
      ? "local_onnx"
      : "openai";
  const localEmbeddingCacheDir = readNonEmptyEnv(
    readConfigEnvValue(input.configEnv, "ALAYA_LOCAL_EMBEDDING_CACHE_DIR")
  );
  const localEmbeddingModel = readNonEmptyEnv(
    readConfigEnvValue(input.configEnv, "ALAYA_LOCAL_EMBEDDING_MODEL")
  );
  const embeddingSupplementOptInEnabled =
    readConfigEnvValue(input.configEnv, "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT") === "true";
  const recallPolicyEmbeddingEnabled = embeddingSupplementOptInEnabled;
  const embeddingProvider: EmbeddingProviderPort | null = resolveEmbeddingProvider({
    providerKind: embeddingProviderKind,
    storageAvailable: memoryEmbeddingRepo !== null,
    optInEnabled: embeddingSupplementOptInEnabled,
    apiKey: embeddingApiKey,
    openAiModel: configuredEmbeddingModel,
    openAiBaseUrl: configuredEmbeddingProviderUrl,
    localCacheDir: localEmbeddingCacheDir,
    localModel: localEmbeddingModel,
    providerOverride: input.embeddingProviderOverride
  });
  const embeddingModelId =
    embeddingProvider?.modelId ??
    (embeddingProviderKind === "local_onnx"
      ? localEmbeddingModel
      : configuredEmbeddingModel ?? (embeddingApiKey === null ? null : DEFAULT_OPENAI_EMBEDDING_MODEL));
  const embeddingStatusService = createEmbeddingStatusService({
    embeddingEnabled: embeddingSupplementOptInEnabled,
    recallPolicyEmbeddingEnabled,
    providerConfigured: embeddingProvider !== null && embeddingProvider.isAvailable,
    modelId: embeddingModelId,
    storageAvailable: memoryEmbeddingRepo !== null,
    degradationSource: input.healthJournalService
  });
  const embeddingRecallService =
    memoryEmbeddingRepo === null || embeddingProvider === null
      ? undefined
      : new EmbeddingRecallService({
          embeddingRepo: memoryEmbeddingRepo,
          provider: embeddingProvider,
          eventLogRepo: input.eventLogRepo,
          healthJournalRecorder: input.healthJournalService,
          warn: input.warn
        });
  const embeddingBackfillHandler =
    memoryEmbeddingRepo === null || embeddingProvider === null
      ? undefined
      : new EmbeddingBackfillHandler({
          memoryRepo: input.memoryEntryRepo,
          memoryEmbeddingRepo,
          provider: embeddingProvider,
          warn: input.warn
        });

  // Recall policy decorator: when the embedding provider is wired and
  // available, override the embedding_similarity RRF fusion weight upward so
  // semantic neighbors compete with structural agreement in the fusion stack.
  // The default RECALL_FUSION_DEFAULT_WEIGHTS[embedding_similarity] is 1 (a
  // mode-invariant baseline); embedding-on raises it via this override so the
  // RRF rank-bounded boost actually fires. Read ALAYA_EMBEDDING_FUSION_WEIGHT_ON
  // for bench-driven retuning (default 6, same magnitude as
  // evidence_structural_agreement).
  //
  // invariant: the decorator's availability check is evaluated PER CALL, not
  // captured at daemon boot. A startup-time capture would have to read
  // `provider.isAvailable` before any embed call could run, which a probe-only
  // gate cannot satisfy; and once a provider degrades mid-run the boot-time
  // capture would also keep injecting weight=6 against an unhealthy provider.
  // The decorator is attached only when the provider exists AND embedding
  // recall is configured at all; per-call it re-reads `provider.isAvailable`
  // and degrades to a noop pass-through when the provider has gone offline.
  // provider-switch runtime detection lives in doctor and runtime-status.
  // see also: docs/handbook/runtime-status.md provider-switch handling.
  const embeddingPolicyConfigured =
    embeddingRecallService !== undefined && embeddingProvider !== null;
  const embeddingFusionWeight = readEmbeddingFusionWeightOverride(input.configEnv);
  const defaultPolicyDecorator = embeddingPolicyConfigured
    ? (policy: Readonly<RecallPolicy>): Readonly<RecallPolicy> => {
        if (embeddingProvider === null || !embeddingProvider.isAvailable) {
          return policy;
        }
        const existingFusionWeights = policy.scoring_weight_overrides?.fusion_weights ?? {};
        return {
          ...policy,
          scoring_weight_overrides: {
            ...(policy.scoring_weight_overrides ?? {}),
            fusion_weights: {
              ...existingFusionWeights,
              embedding_similarity: embeddingFusionWeight
            }
          }
        };
      }
    : undefined;

  // Fire-and-forget provider warmup: nudges the provider to load its model
  // (e.g. ONNX weights) so the first user-driven recall is not blocked on a
  // cold-start cost (~30s for the local ONNX MiniLM). A failure here is
  // logged but does not abort daemon startup — the dynamic isAvailable gate
  // and the EmbeddingRecallService degradation events already cover unhealthy
  // providers. The probe text is invariant ("alaya-init-probe") so a remote
  // provider sees the same warmup input across boots.
  const providerWarmup = embeddingProvider === null
    ? Promise.resolve<"not_requested" | "ready" | "failed">("not_requested")
    : embeddingProvider
        .embedTexts(["alaya-init-probe"], { timeoutMs: 60_000 })
        .then(() => "ready" as const)
        .catch((error: unknown) => {
          input.warn("embedding provider warmup failed", {
            provider_kind: embeddingProvider.providerKind,
            model_id: embeddingProvider.modelId,
            error: error instanceof Error ? error.message : String(error)
          });
          return "failed" as const;
        });

  return {
    embeddingApiKey,
    embeddingStatusService,
    embeddingRecallService,
    embeddingBackfillHandler,
    defaultPolicyDecorator,
    providerWarmup
  };
}

const DEFAULT_EMBEDDING_FUSION_WEIGHT_ON = 6;

function readEmbeddingFusionWeightOverride(
  configEnv: ReadonlyMap<string, string>
): number {
  const raw = readNonEmptyEnv(readConfigEnvValue(configEnv, "ALAYA_EMBEDDING_FUSION_WEIGHT_ON"));
  if (raw === null) {
    return DEFAULT_EMBEDDING_FUSION_WEIGHT_ON;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_EMBEDDING_FUSION_WEIGHT_ON;
  }
  return parsed;
}

function resolveEmbeddingProvider(input: {
  readonly providerKind: "openai" | "local_onnx";
  readonly storageAvailable: boolean;
  readonly optInEnabled: boolean;
  readonly apiKey: string | null;
  readonly openAiModel: string | null;
  readonly openAiBaseUrl: string | null;
  readonly localCacheDir: string | null;
  readonly localModel: string | null;
  readonly providerOverride?: EmbeddingProviderPort | null;
}): EmbeddingProviderPort | null {
  if (!input.storageAvailable || !input.optInEnabled) {
    return null;
  }
  if (input.providerOverride !== undefined) {
    return input.providerOverride;
  }

  if (input.providerKind === "local_onnx") {
    return new LocalOnnxEmbeddingClient({
      cacheDir: input.localCacheDir ?? defaultLocalOnnxCacheDir(),
      ...(input.localModel === null ? {} : { modelId: input.localModel })
    });
  }

  if (input.apiKey === null) {
    return null;
  }
  return new OpenAIEmbeddingClient({
    apiKey: input.apiKey,
    model: input.openAiModel ?? undefined,
    baseUrl: input.openAiBaseUrl ?? undefined
  });
}


function resolveOptionalEmbeddingApiKey(
  rawSecretRef: string | undefined,
  warn: (message: string, meta: Record<string, unknown>) => void
): string | null {
  if (rawSecretRef === undefined || rawSecretRef.trim().length === 0) {
    return null;
  }

  const resolved = resolveSecretRef(rawSecretRef);
  if (!("kind" in resolved)) {
    return resolved.value;
  }

  if (resolved.kind === "malformed" || resolved.kind === "empty") {
    throw new Error(formatEmbeddingSecretResolutionError(resolved));
  }

  warn("embedding provider unavailable; falling back to keyword recall", {
    reason: resolved.kind,
    secret_ref_source: describeSecretRefSource(resolved)
  });
  return null;
}

function describeSecretRefSource(error: ResolveSecretError): string {
  switch (error.kind) {
    case "env_missing":
      return `env:${error.var_name}`;
    case "file_missing":
    case "file_unreadable":
      return "file";
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return `keychain:${error.service}:${error.account}`;
    case "malformed":
    case "empty":
      return "invalid";
  }
}

function formatEmbeddingSecretResolutionError(error: ResolveSecretError): string {
  switch (error.kind) {
    case "malformed":
      return `ALAYA_OPENAI_SECRET_REF: ${error.ref} -> ${error.reason}`;
    case "empty":
      return `ALAYA_OPENAI_SECRET_REF: ${error.ref} -> ${error.origin} secret is empty`;
    case "env_missing":
    case "file_missing":
    case "file_unreadable":
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return "ALAYA_OPENAI_SECRET_REF is unavailable";
  }
}
