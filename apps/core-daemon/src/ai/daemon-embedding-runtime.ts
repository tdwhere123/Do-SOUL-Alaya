import {
  D2Q_SCHEMA_VERSION,
  EmbeddingBackfillHandler,
  EmbeddingRecallService,
  LocalOnnxCrossEncoderClient,
  LocalOnnxEmbeddingClient,
  OpenAIEmbeddingClient,
  defaultLocalOnnxCacheDir,
  type EmbeddingProviderPort,
  type EmbeddingRecallEventLogPort,
  type EmbeddingRecallServiceDependencies,
  type HqProvider
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
  createOptionalMemoryHqRepo
} from "../runtime/index.js";
import {
  isD2qActive,
  readEmbeddingRuntimeConfig,
  type EmbeddingRuntimeConfig
} from "./daemon-embedding-runtime-config.js";
import {
  createEmbeddingProviderReadiness,
  observeEmbeddingProviderReadiness,
  type EmbeddingProviderReadiness
} from "./daemon-embedding-provider-readiness.js";
import { resolveEmbeddingWarmupHoldReason } from "./embedding-warmup-hold.js";

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
  const runtimeConfig = readEmbeddingRuntimeConfig(input.configEnv, input.warn);
  const providerState = createEmbeddingProviderState(input, runtimeConfig);
  const services = createEmbeddingRuntimeServices(input, runtimeConfig, providerState);

  return {
    embeddingApiKey: runtimeConfig.embeddingApiKey,
    embeddingStatusService: services.embeddingStatusService,
    embeddingRecallService: services.embeddingRecallService,
    answerRerankService: createAnswerRerankService(runtimeConfig),
    embeddingBackfillHandler: services.embeddingBackfillHandler,
    defaultPolicyDecorator: services.defaultPolicyDecorator,
    providerWarmup: services.providerWarmup,
    getWarmupHoldReason: () => resolveEmbeddingWarmupHoldReason(providerState.readiness.status)
  };
}

interface EmbeddingProviderState {
  readonly memoryEmbeddingRepo: ReturnType<typeof createOptionalMemoryEmbeddingRepo>;
  readonly embeddingProvider: EmbeddingProviderPort | null;
  readonly embeddingModelId: string | null;
  readonly readiness: EmbeddingProviderReadiness;
}

function createAnswerRerankService(
  config: EmbeddingRuntimeConfig
): LocalOnnxCrossEncoderClient | undefined {
  if (!config.localAnswerRerankEnabled) return undefined;
  return new LocalOnnxCrossEncoderClient({
    cacheDir: config.localAnswerRerankCacheDir ?? defaultLocalOnnxCacheDir(),
    ...(config.localAnswerRerankModel === null
      ? {}
      : { modelId: config.localAnswerRerankModel })
  });
}

function createEmbeddingProviderState(
  input: Parameters<typeof createDaemonEmbeddingRuntime>[0],
  config: EmbeddingRuntimeConfig
): EmbeddingProviderState {
  const memoryEmbeddingRepo = createOptionalMemoryEmbeddingRepo(input.database);
  const resolvedProvider = resolveEmbeddingProvider({
    providerKind: config.embeddingProviderKind,
    storageAvailable: memoryEmbeddingRepo !== null,
    optInEnabled: config.embeddingSupplementEnabled,
    apiKey: config.embeddingApiKey,
    openAiModel: config.configuredEmbeddingModel,
    openAiBaseUrl: config.configuredEmbeddingProviderUrl,
    localCacheDir: config.localEmbeddingCacheDir,
    localModel: config.localEmbeddingModel,
    localSchemaVersion: isD2qActive(config) ? D2Q_SCHEMA_VERSION : null,
    providerOverride: input.embeddingProviderOverride
  });
  const readiness = createEmbeddingProviderReadiness(resolvedProvider);
  const embeddingProvider = observeEmbeddingProviderReadiness(resolvedProvider, readiness);
  return {
    memoryEmbeddingRepo,
    embeddingProvider,
    embeddingModelId:
      embeddingProvider?.modelId ??
      (config.embeddingProviderKind === "local_onnx"
        ? config.localEmbeddingModel
        : config.configuredEmbeddingModel ??
          (config.embeddingApiKey === null ? null : DEFAULT_OPENAI_EMBEDDING_MODEL)),
    readiness
  };
}

function createEmbeddingRuntimeServices(
  input: Parameters<typeof createDaemonEmbeddingRuntime>[0],
  config: EmbeddingRuntimeConfig,
  providerState: EmbeddingProviderState
) {
  const providerWarmup = createProviderWarmup(
    providerState.embeddingProvider,
    input.warn,
    providerState.readiness
  );
  const embeddingStatusService = createEmbeddingStatusService({
    embeddingEnabled: config.embeddingSupplementEnabled,
    recallPolicyEmbeddingEnabled: config.recallPolicyEmbeddingEnabled,
    providerConfigured: providerState.embeddingProvider !== null,
    providerAvailable: () => providerState.embeddingProvider?.isAvailable === true,
    providerWarmupStatus: () => providerState.readiness.status,
    modelId: providerState.embeddingModelId,
    storageAvailable: providerState.memoryEmbeddingRepo !== null,
    degradationSource: input.healthJournalService
  });
  const embeddingRecallService = createEmbeddingRecallService(input, providerState);
  return {
    embeddingStatusService,
    embeddingRecallService,
    embeddingBackfillHandler: createEmbeddingBackfillHandler(input, config, providerState),
    defaultPolicyDecorator: createDefaultPolicyDecorator(
      config.recallPolicyEmbeddingEnabled,
      embeddingRecallService,
      providerState.embeddingProvider,
      providerState.readiness
    ),
    providerWarmup
  };
}

function createEmbeddingRecallService(
  input: Parameters<typeof createDaemonEmbeddingRuntime>[0],
  providerState: EmbeddingProviderState
) {
  if (providerState.memoryEmbeddingRepo === null || providerState.embeddingProvider === null) {
    return undefined;
  }
  return new EmbeddingRecallService({
    embeddingRepo: providerState.memoryEmbeddingRepo,
    provider: providerState.embeddingProvider,
    eventLogRepo: input.eventLogRepo,
    healthJournalRecorder: input.healthJournalService,
    warn: input.warn
  });
}

function createEmbeddingBackfillHandler(
  input: Parameters<typeof createDaemonEmbeddingRuntime>[0],
  config: EmbeddingRuntimeConfig,
  providerState: EmbeddingProviderState
) {
  if (providerState.memoryEmbeddingRepo === null || providerState.embeddingProvider === null) {
    return undefined;
  }
  const hqProvider = resolveBackfillHqProvider(input, config);
  return new EmbeddingBackfillHandler({
    memoryRepo: input.memoryEntryRepo,
    memoryEmbeddingRepo: providerState.memoryEmbeddingRepo,
    provider: providerState.embeddingProvider,
    ...(hqProvider === null ? {} : { hqProvider }),
    warn: input.warn
  });
}

function resolveBackfillHqProvider(
  input: Parameters<typeof createDaemonEmbeddingRuntime>[0],
  config: EmbeddingRuntimeConfig
): HqProvider | null {
  if (!isD2qActive(config)) {
    return null;
  }
  return createOptionalMemoryHqRepo(input.database);
}

function createDefaultPolicyDecorator(
  recallPolicyEmbeddingEnabled: boolean,
  embeddingRecallService: EmbeddingRecallService | undefined,
  embeddingProvider: EmbeddingProviderPort | null,
  readiness: EmbeddingProviderReadiness
): ((policy: Readonly<RecallPolicy>) => Readonly<RecallPolicy>) | undefined {
  const embeddingPolicyConfigured =
    embeddingRecallService !== undefined &&
    embeddingProvider !== null &&
    recallPolicyEmbeddingEnabled;
  if (!embeddingPolicyConfigured) {
    return undefined;
  }
  return (policy: Readonly<RecallPolicy>): Readonly<RecallPolicy> => {
    // Hold embedding-on until warmup verifies the provider; pending/failed stay lexical-only.
    if (readiness.status !== "ready") {
      return policy;
    }
    return applyEmbeddingPolicyDecorator(policy, embeddingProvider);
  };
}

function applyEmbeddingPolicyDecorator(
  policy: Readonly<RecallPolicy>,
  embeddingProvider: EmbeddingProviderPort | null
): Readonly<RecallPolicy> {
  if (embeddingProvider === null || !embeddingProvider.isAvailable) {
    return policy;
  }
  const existingFusionWeights = policy.scoring_weight_overrides?.fusion_weights ?? {};
  const semantic = policy.coarse_filter.semantic_supplement;
  return {
    ...policy,
    coarse_filter: {
      ...policy.coarse_filter,
      semantic_supplement: {
        ...semantic,
        enabled: true,
        embedding_enabled: true,
        injection_cap: semantic.injection_cap ?? DEFAULT_EMBEDDING_INJECTION_CAP,
        injection_similarity_floor:
          semantic.injection_similarity_floor ?? DEFAULT_EMBEDDING_INJECTION_FLOOR
      }
    },
    scoring_weight_overrides: {
      ...(policy.scoring_weight_overrides ?? {}),
      fusion_weights: {
        embedding_similarity: DEFAULT_EMBEDDING_FUSION_WEIGHT,
        ...existingFusionWeights
      }
    }
  };
}

function createProviderWarmup(
  embeddingProvider: EmbeddingProviderPort | null,
  warn: (message: string, meta: Record<string, unknown>) => void,
  readiness: EmbeddingProviderReadiness
): Promise<"not_requested" | "ready" | "failed"> {
  if (embeddingProvider === null) {
    return Promise.resolve("not_requested");
  }
  return Promise.resolve()
    .then(async () => {
      await embeddingProvider.embedTexts(["alaya-init-probe"], { timeoutMs: 60_000 });
      return "ready" as const;
    })
    .catch((error: unknown) => {
      readiness.markFailed();
      // Loud operator signal: bi-default-on is lexical-only until recovery.
      warn("embedding provider warmup FAILED — recall stays lexical-only until recovery", {
        provider_kind: embeddingProvider.providerKind,
        model_id: embeddingProvider.modelId,
        degraded_reason: "provider_warmup_failed",
        error: error instanceof Error ? error.message : String(error)
      });
      return "failed" as const;
    });
}

// Equal family ballot with RECALL_FUSION_DEFAULT_WEIGHTS — not a fitted emb boost.
const DEFAULT_EMBEDDING_FUSION_WEIGHT = 1;
// mirror: packages/core/src/recall/supplements.ts EMBEDDING_MAX_INJECTED_DELIVERY / EMBEDDING_INJECTION_SIMILARITY_FLOOR
const DEFAULT_EMBEDDING_INJECTION_CAP = 10;
const DEFAULT_EMBEDDING_INJECTION_FLOOR = 0.5;

function resolveEmbeddingProvider(input: {
  readonly providerKind: "openai" | "local_onnx";
  readonly storageAvailable: boolean;
  readonly optInEnabled: boolean;
  readonly apiKey: string | null;
  readonly openAiModel: string | null;
  readonly openAiBaseUrl: string | null;
  readonly localCacheDir: string | null;
  readonly localModel: string | null;
  readonly localSchemaVersion: number | null;
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
      ...(input.localModel === null ? {} : { modelId: input.localModel }),
      ...(input.localSchemaVersion === null ? {} : { schemaVersion: input.localSchemaVersion })
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
