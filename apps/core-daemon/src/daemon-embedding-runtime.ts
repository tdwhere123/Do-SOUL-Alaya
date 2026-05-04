import {
  EmbeddingBackfillHandler,
  EmbeddingRecallService,
  OpenAIEmbeddingClient,
  type EmbeddingRecallEventLogPort,
  type EmbeddingRecallServiceDependencies
} from "@do-soul/alaya-core";
import type { SqliteMemoryEntryRepo, StorageDatabase } from "@do-soul/alaya-storage";
import {
  createEmbeddingStatusService,
  type EmbeddingStatusDegradationSource
} from "./services/embedding-status-service.js";
import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  createOptionalMemoryEmbeddingRepo,
  readConfigEnvValue,
  readNonEmptyEnv,
  readOptionalSecretRef
} from "./daemon-runtime-support.js";

export function createDaemonEmbeddingRuntime(input: {
  readonly database: StorageDatabase;
  readonly configEnv: ReadonlyMap<string, string>;
  readonly eventLogRepo: EmbeddingRecallEventLogPort;
  readonly healthJournalService: EmbeddingStatusDegradationSource &
    NonNullable<EmbeddingRecallServiceDependencies["healthJournalRecorder"]>;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}) {
  const memoryEmbeddingRepo = createOptionalMemoryEmbeddingRepo(input.database);
  const rawEmbeddingSecretRef = readConfigEnvValue(input.configEnv, "ALAYA_OPENAI_SECRET_REF");
  const embeddingApiKey = readOptionalSecretRef(
    rawEmbeddingSecretRef,
    "ALAYA_OPENAI_SECRET_REF"
  );
  const configuredEmbeddingModel = readNonEmptyEnv(readConfigEnvValue(input.configEnv, "OPENAI_EMBEDDING_MODEL"));
  const configuredEmbeddingProviderUrl = readNonEmptyEnv(
    readConfigEnvValue(input.configEnv, "OPENAI_EMBEDDING_PROVIDER_URL")
  );
  const embeddingModelId = configuredEmbeddingModel ?? (embeddingApiKey === null ? null : DEFAULT_OPENAI_EMBEDDING_MODEL);
  const embeddingSupplementOptInEnabled =
    readConfigEnvValue(input.configEnv, "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT") === "true";
  const recallPolicyEmbeddingEnabled = false;
  const embeddingStatusService = createEmbeddingStatusService({
    embeddingEnabled: embeddingSupplementOptInEnabled,
    recallPolicyEmbeddingEnabled,
    providerConfigured: embeddingApiKey !== null,
    modelId: embeddingModelId,
    storageAvailable: memoryEmbeddingRepo !== null,
    degradationSource: input.healthJournalService
  });
  const embeddingProvider =
    memoryEmbeddingRepo === null || !embeddingSupplementOptInEnabled || embeddingApiKey === null
      ? null
      : new OpenAIEmbeddingClient({
          apiKey: embeddingApiKey,
          model: configuredEmbeddingModel ?? undefined,
          baseUrl: configuredEmbeddingProviderUrl ?? undefined
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

  return {
    embeddingApiKey,
    embeddingStatusService,
    embeddingRecallService,
    embeddingBackfillHandler
  };
}
