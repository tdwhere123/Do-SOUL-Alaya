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
  readNonEmptyEnv
} from "./daemon-runtime-support.js";
import { resolveSecretRef, type ResolveSecretError } from "./secrets.js";

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
  const embeddingApiKey = resolveOptionalEmbeddingApiKey(rawEmbeddingSecretRef, input.warn);
  const configuredEmbeddingModel = readNonEmptyEnv(readConfigEnvValue(input.configEnv, "OPENAI_EMBEDDING_MODEL"));
  const configuredEmbeddingProviderUrl = readNonEmptyEnv(
    readConfigEnvValue(input.configEnv, "OPENAI_EMBEDDING_PROVIDER_URL")
  );
  const embeddingModelId = configuredEmbeddingModel ?? (embeddingApiKey === null ? null : DEFAULT_OPENAI_EMBEDDING_MODEL);
  const embeddingSupplementOptInEnabled =
    readConfigEnvValue(input.configEnv, "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT") === "true";
  const recallPolicyEmbeddingEnabled = embeddingSupplementOptInEnabled;
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
