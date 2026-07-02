import {
  D2Q_SCHEMA_VERSION,
  EmbeddingBackfillHandler,
  EmbeddingRecallService,
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
  createOptionalMemoryHqRepo,
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
  const runtimeConfig = readEmbeddingRuntimeConfig(input.configEnv, input.warn);
  const providerState = createEmbeddingProviderState(input, runtimeConfig);
  const services = createEmbeddingRuntimeServices(input, runtimeConfig, providerState);

  return {
    embeddingApiKey: runtimeConfig.embeddingApiKey,
    embeddingStatusService: services.embeddingStatusService,
    embeddingRecallService: services.embeddingRecallService,
    embeddingBackfillHandler: services.embeddingBackfillHandler,
    defaultPolicyDecorator: services.defaultPolicyDecorator,
    providerWarmup: services.providerWarmup
  };
}

interface EmbeddingRuntimeConfig {
  readonly rawEmbeddingSecretRef: string | undefined;
  readonly embeddingApiKey: string | null;
  readonly configuredEmbeddingModel: string | null;
  readonly configuredEmbeddingProviderUrl: string | null;
  readonly explicitEmbeddingProvider: "openai" | "local_onnx" | null;
  readonly embeddingProviderKind: "openai" | "local_onnx";
  readonly localEmbeddingCacheDir: string | null;
  readonly localEmbeddingModel: string | null;
  readonly embeddingSupplementOptInEnabled: boolean;
  readonly recallPolicyEmbeddingEnabled: boolean;
  readonly d2qEnabled: boolean;
}

interface EmbeddingProviderState {
  readonly memoryEmbeddingRepo: ReturnType<typeof createOptionalMemoryEmbeddingRepo>;
  readonly embeddingProvider: EmbeddingProviderPort | null;
  readonly embeddingModelId: string | null;
}

function readEmbeddingRuntimeConfig(
  configEnv: ReadonlyMap<string, string>,
  warn: (message: string, meta: Record<string, unknown>) => void
): EmbeddingRuntimeConfig {
  const rawEmbeddingSecretRef = readConfigEnvValue(configEnv, "ALAYA_OPENAI_SECRET_REF");
  const configuredEmbeddingModel = readNonEmptyEnv(readConfigEnvValue(configEnv, "OPENAI_EMBEDDING_MODEL"));
  const explicitEmbeddingProvider = readExplicitEmbeddingProvider(configEnv);
  const embeddingOptInRaw = readConfigEnvValue(configEnv, "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT");
  return {
    rawEmbeddingSecretRef,
    embeddingApiKey: resolveOptionalEmbeddingApiKey(rawEmbeddingSecretRef, warn),
    configuredEmbeddingModel,
    configuredEmbeddingProviderUrl: readNonEmptyEnv(readConfigEnvValue(configEnv, "OPENAI_EMBEDDING_PROVIDER_URL")),
    explicitEmbeddingProvider,
    embeddingProviderKind: resolveEmbeddingProviderKind(rawEmbeddingSecretRef, configuredEmbeddingModel, explicitEmbeddingProvider),
    localEmbeddingCacheDir: readNonEmptyEnv(readConfigEnvValue(configEnv, "ALAYA_LOCAL_EMBEDDING_CACHE_DIR")),
    localEmbeddingModel: readNonEmptyEnv(readConfigEnvValue(configEnv, "ALAYA_LOCAL_EMBEDDING_MODEL")),
    embeddingSupplementOptInEnabled:
      embeddingOptInRaw === "true" ||
      (explicitEmbeddingProvider === "local_onnx" && embeddingOptInRaw !== "false"),
    recallPolicyEmbeddingEnabled:
      embeddingOptInRaw === "true" ||
      (explicitEmbeddingProvider === "local_onnx" && embeddingOptInRaw !== "false"),
    d2qEnabled: readD2qEnabled(configEnv)
  };
}

function readD2qEnabled(configEnv: ReadonlyMap<string, string>): boolean {
  const raw = readNonEmptyEnv(readConfigEnvValue(configEnv, "ALAYA_RECALL_D2Q"))?.toLowerCase();
  return raw === "1" || raw === "true";
}

function readExplicitEmbeddingProvider(
  configEnv: ReadonlyMap<string, string>
): "openai" | "local_onnx" | null {
  const explicitProvider = readNonEmptyEnv(readConfigEnvValue(configEnv, "ALAYA_EMBEDDING_PROVIDER"));
  return explicitProvider === "openai" || explicitProvider === "local_onnx"
    ? explicitProvider
    : null;
}

function resolveEmbeddingProviderKind(
  rawEmbeddingSecretRef: string | undefined,
  configuredEmbeddingModel: string | null,
  explicitEmbeddingProvider: "openai" | "local_onnx" | null
): "openai" | "local_onnx" {
  const hasExistingOpenAiConfig =
    (rawEmbeddingSecretRef?.trim().length ?? 0) > 0 || configuredEmbeddingModel !== null;
  if (explicitEmbeddingProvider === "local_onnx") {
    return "local_onnx";
  }
  if (explicitEmbeddingProvider === "openai" || hasExistingOpenAiConfig) {
    return "openai";
  }
  return "local_onnx";
}

function createEmbeddingProviderState(
  input: Parameters<typeof createDaemonEmbeddingRuntime>[0],
  config: EmbeddingRuntimeConfig
): EmbeddingProviderState {
  const memoryEmbeddingRepo = createOptionalMemoryEmbeddingRepo(input.database);
  const embeddingProvider = resolveEmbeddingProvider({
    providerKind: config.embeddingProviderKind,
    storageAvailable: memoryEmbeddingRepo !== null,
    optInEnabled: config.embeddingSupplementOptInEnabled,
    apiKey: config.embeddingApiKey,
    openAiModel: config.configuredEmbeddingModel,
    openAiBaseUrl: config.configuredEmbeddingProviderUrl,
    localCacheDir: config.localEmbeddingCacheDir,
    localModel: config.localEmbeddingModel,
    localSchemaVersion: isD2qActive(config) ? D2Q_SCHEMA_VERSION : null,
    providerOverride: input.embeddingProviderOverride
  });
  return {
    memoryEmbeddingRepo,
    embeddingProvider,
    embeddingModelId:
      embeddingProvider?.modelId ??
      (config.embeddingProviderKind === "local_onnx"
        ? config.localEmbeddingModel
        : config.configuredEmbeddingModel ??
          (config.embeddingApiKey === null ? null : DEFAULT_OPENAI_EMBEDDING_MODEL))
  };
}

function createEmbeddingRuntimeServices(
  input: Parameters<typeof createDaemonEmbeddingRuntime>[0],
  config: EmbeddingRuntimeConfig,
  providerState: EmbeddingProviderState
) {
  const embeddingStatusService = createEmbeddingStatusService({
    embeddingEnabled: config.embeddingSupplementOptInEnabled,
    recallPolicyEmbeddingEnabled: config.recallPolicyEmbeddingEnabled,
    providerConfigured:
      providerState.embeddingProvider !== null && providerState.embeddingProvider.isAvailable,
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
      input.configEnv,
      config.recallPolicyEmbeddingEnabled,
      embeddingRecallService,
      providerState.embeddingProvider
    ),
    providerWarmup: createProviderWarmup(providerState.embeddingProvider, input.warn)
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

// d2q is the proven MiniLM doc2query path; gate the HQ source + schema bump on
// the local provider so an OpenAI deployment never invalidates its vectors.
function isD2qActive(config: EmbeddingRuntimeConfig): boolean {
  return config.d2qEnabled && config.embeddingProviderKind === "local_onnx";
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
  configEnv: ReadonlyMap<string, string>,
  recallPolicyEmbeddingEnabled: boolean,
  embeddingRecallService: EmbeddingRecallService | undefined,
  embeddingProvider: EmbeddingProviderPort | null
): ((policy: Readonly<RecallPolicy>) => Readonly<RecallPolicy>) | undefined {
  const embeddingPolicyConfigured =
    embeddingRecallService !== undefined &&
    embeddingProvider !== null &&
    recallPolicyEmbeddingEnabled;
  if (!embeddingPolicyConfigured) {
    return undefined;
  }
  const embeddingFusionWeight = readEmbeddingFusionWeightOverride(configEnv);
  const policyDecoratorDisabled = readPolicyDecoratorDisabled(configEnv);
  return (policy: Readonly<RecallPolicy>): Readonly<RecallPolicy> =>
    applyEmbeddingPolicyDecorator(
      policy,
      embeddingProvider,
      embeddingFusionWeight,
      policyDecoratorDisabled
    );
}

function applyEmbeddingPolicyDecorator(
  policy: Readonly<RecallPolicy>,
  embeddingProvider: EmbeddingProviderPort | null,
  embeddingFusionWeight: number,
  policyDecoratorDisabled: boolean
): Readonly<RecallPolicy> {
  if (policyDecoratorDisabled || embeddingProvider === null || !embeddingProvider.isAvailable) {
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
        ...existingFusionWeights,
        embedding_similarity: embeddingFusionWeight
      }
    }
  };
}

function createProviderWarmup(
  embeddingProvider: EmbeddingProviderPort | null,
  warn: (message: string, meta: Record<string, unknown>) => void
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
      warn("embedding provider warmup failed", {
        provider_kind: embeddingProvider.providerKind,
        model_id: embeddingProvider.modelId,
        error: error instanceof Error ? error.message : String(error)
      });
      return "failed" as const;
    });
}

const DEFAULT_EMBEDDING_FUSION_WEIGHT_ON = 6;
// mirror: packages/core/src/recall/supplements.ts EMBEDDING_MAX_INJECTED_DELIVERY / EMBEDDING_INJECTION_SIMILARITY_FLOOR
const DEFAULT_EMBEDDING_INJECTION_CAP = 10;
const DEFAULT_EMBEDDING_INJECTION_FLOOR = 0.5;

function readPolicyDecoratorDisabled(configEnv: ReadonlyMap<string, string>): boolean {
  const raw = readNonEmptyEnv(
    readConfigEnvValue(configEnv, "ALAYA_DISABLE_POLICY_EMBEDDING_DECORATOR")
  )?.toLowerCase();
  return raw === "1" || raw === "true";
}

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
