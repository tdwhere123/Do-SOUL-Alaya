import {
  D2Q_SCHEMA_VERSION,
  EmbeddingBackfillHandler,
  EmbeddingRecallService,
  EvidenceDocumentEmbeddingBackfillHandler,
  LocalOnnxEmbeddingClient,
  OpenAIEmbeddingClient,
  applyRecallPolicyEmbeddingState,
  assertValidEmbeddingBatch,
  defaultLocalOnnxCacheDir,
  EMBEDDING_INJECTION_SIMILARITY_FLOOR,
  EMBEDDING_MAX_INJECTED_DELIVERY,
  type EmbeddingProviderPort,
  type EmbeddingRecallEventLogPort,
  type EmbeddingRecallServiceDependencies,
  type HqProvider
} from "@do-soul/alaya-core";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import {
  RecallQualifiedEvidenceReader,
  type SqliteMemoryEntryRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { verifyOfficialApiSourceLocatorBinding } from "@do-soul/alaya-soul";
import {
  createEmbeddingStatusService,
  type EmbeddingStatusDegradationSource
} from "../services/status/embedding-status-service.js";
import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  createOptionalEvidenceRecallEmbeddingRepo,
  createOptionalMemoryEmbeddingRepo,
  createOptionalMemoryHqRepo
} from "../runtime/index.js";
import {
  isD2qActive,
  readEmbeddingRuntimeConfig,
  type EmbeddingProviderKind,
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
    embeddingBackfillHandler: services.embeddingBackfillHandler,
    defaultPolicyDecorator: services.defaultPolicyDecorator,
    providerWarmup: services.providerWarmup,
    getProviderDimensions: () => providerState.readiness.dimensions,
    getWarmupHoldReason: () => resolveEmbeddingWarmupHoldReason(providerState.readiness.status),
    closeProvider: () => closeEmbeddingProvider(providerState.embeddingProvider)
  };
}

interface EmbeddingProviderState {
  readonly memoryEmbeddingRepo: ReturnType<typeof createOptionalMemoryEmbeddingRepo>;
  readonly evidenceEmbeddingRepo: ReturnType<typeof createOptionalEvidenceRecallEmbeddingRepo>;
  readonly embeddingProvider: EmbeddingProviderPort | null;
  readonly embeddingModelId: string | null;
  readonly readiness: EmbeddingProviderReadiness;
}

function createEmbeddingProviderState(
  input: Parameters<typeof createDaemonEmbeddingRuntime>[0],
  config: EmbeddingRuntimeConfig
): EmbeddingProviderState {
  const memoryEmbeddingRepo = createOptionalMemoryEmbeddingRepo(input.database);
  const evidenceEmbeddingRepo = createOptionalEvidenceRecallEmbeddingRepo(input.database);
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
    evidenceEmbeddingRepo,
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
    ...(providerState.evidenceEmbeddingRepo === null
      ? {}
      : { evidenceDocumentEmbeddingRepo: providerState.evidenceEmbeddingRepo }),
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
  const memoryHandler = new EmbeddingBackfillHandler({
    memoryRepo: input.memoryEntryRepo,
    memoryEmbeddingRepo: providerState.memoryEmbeddingRepo,
    provider: providerState.embeddingProvider,
    expectedDimensions: () => providerState.readiness.dimensions,
    ...(hqProvider === null ? {} : { hqProvider }),
    warn: input.warn
  });
  if (providerState.evidenceEmbeddingRepo === null) return memoryHandler;
  const receiptQualification = new RecallQualifiedEvidenceReader(
    input.database,
    verifyOfficialApiSourceLocatorBinding
  );
  const evidenceHandler = new EvidenceDocumentEmbeddingBackfillHandler({
    evidenceDocumentEmbeddingRepo: providerState.evidenceEmbeddingRepo,
    receiptQualification,
    provider: providerState.embeddingProvider,
    warn: input.warn
  });
  return composeEmbeddingBackfillHandlers(memoryHandler, evidenceHandler);
}

function composeEmbeddingBackfillHandlers(
  memoryHandler: EmbeddingBackfillHandler,
  evidenceHandler: EvidenceDocumentEmbeddingBackfillHandler
) {
  return {
    handle: async (task: Parameters<EmbeddingBackfillHandler["handle"]>[0]) => {
      const memory = await memoryHandler.handle(task);
      const evidence = await evidenceHandler.handle(task);
      return Object.freeze({
        objectsAffected: memory.objectsAffected,
        auditEntries: Object.freeze([...memory.auditEntries, ...evidence.auditEntries])
      });
    }
  };
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
    if (readiness.status !== "ready") {
      return applyRecallPolicyEmbeddingState(policy, { embeddingEnabled: false });
    }
    return applyEmbeddingPolicyDecorator(policy, embeddingProvider);
  };
}

function applyEmbeddingPolicyDecorator(
  policy: Readonly<RecallPolicy>,
  embeddingProvider: EmbeddingProviderPort | null
): Readonly<RecallPolicy> {
  if (embeddingProvider === null || !embeddingProvider.isAvailable) {
    return applyRecallPolicyEmbeddingState(policy, { embeddingEnabled: false });
  }
  const existingFusionWeights = policy.scoring_weight_overrides?.fusion_weights ?? {};
  const semantic = policy.coarse_filter.semantic_supplement;
  const embeddingPolicy = applyRecallPolicyEmbeddingState(policy, {
    embeddingEnabled: true,
    injectionCap: semantic.injection_cap ?? EMBEDDING_MAX_INJECTED_DELIVERY,
    injectionSimilarityFloor:
      semantic.injection_similarity_floor ?? EMBEDDING_INJECTION_SIMILARITY_FLOOR
  });
  return {
    ...embeddingPolicy,
    scoring_weight_overrides: {
      ...(embeddingPolicy.scoring_weight_overrides ?? {}),
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
  return embeddingProvider
    .embedTexts(["alaya-init-probe"], { timeoutMs: 60_000 })
    .then((embeddings) => {
      assertValidEmbeddingBatch(embeddings, 1);
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

function resolveEmbeddingProvider(input: {
  readonly providerKind: EmbeddingProviderKind;
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
    if (input.optInEnabled) {
      throw new Error(
        "ALAYA_EMBEDDING_PROVIDER=openai requires a resolvable ALAYA_OPENAI_SECRET_REF"
      );
    }
    return null;
  }
  return new OpenAIEmbeddingClient({
    apiKey: input.apiKey,
    model: input.openAiModel ?? undefined,
    baseUrl: input.openAiBaseUrl ?? undefined
  });
}

async function closeEmbeddingProvider(provider: EmbeddingProviderPort | null): Promise<void> {
  if (provider?.close === undefined) return;
  await provider.close();
}
