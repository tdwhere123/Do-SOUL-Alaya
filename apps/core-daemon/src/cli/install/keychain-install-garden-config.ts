import path from "node:path";
import { EventPublisher } from "@do-soul/alaya-core";
import {
  GardenEventType,
  HealthEventKind,
  RuntimeGardenComputeConfigSchema,
  SoulHealthJournalRecordedPayloadSchema,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import { initDatabase, SqliteConfigRepo, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import type { AlayaConfigPaths } from "../config-files.js";
import {
  RUNTIME_GARDEN_COMPUTE_CONFIG_KEY,
  fileExists,
  readOptional,
  readTomlString
} from "./support.js";

export async function patchPersistedGardenSecretRefIfPresent(
  dbPath: string,
  secretRef: string,
  occurredAt: string
): Promise<{ readonly before: RuntimeGardenComputeConfig; readonly after: RuntimeGardenComputeConfig } | null> {
  if (!(await fileExists(dbPath))) {
    return null;
  }
  const database = initDatabase({ filename: dbPath });
  const configRepo = new SqliteConfigRepo(database);
  const current = readPersistedGardenComputeConfig(configRepo);
  if (current === null) {
    return null;
  }
  const after = buildUpdatedPersistedGardenConfig(current, secretRef);
  await appendPersistedGardenConfigSecretRefChange(database, configRepo, after, occurredAt);
  return { before: current, after };
}

export async function restorePersistedGardenConfig(
  paths: AlayaConfigPaths,
  config: RuntimeGardenComputeConfig | null
): Promise<void> {
  const dbPath = await resolveExistingDbPath(paths);
  if (!(await fileExists(dbPath)) || config === null) {
    return;
  }
  new SqliteConfigRepo(initDatabase({ filename: dbPath })).setParsed(
    RUNTIME_GARDEN_COMPUTE_CONFIG_KEY,
    config,
    RuntimeGardenComputeConfigSchema
  );
}

export async function resolveExistingDbPath(paths: AlayaConfigPaths): Promise<string> {
  const toml = await readOptional(paths.tomlPath);
  const dbPath = toml === null ? null : readTomlString(toml, "storage", "db_path");
  return path.resolve(dbPath ?? path.join(paths.configDir, "alaya.db"));
}

function readPersistedGardenComputeConfig(
  configRepo: SqliteConfigRepo
): RuntimeGardenComputeConfig | null {
  const stored = configRepo.getParsed(
    RUNTIME_GARDEN_COMPUTE_CONFIG_KEY,
    RuntimeGardenComputeConfigSchema
  );
  return stored === null ? null : RuntimeGardenComputeConfigSchema.parse(stored);
}

function buildUpdatedPersistedGardenConfig(
  current: RuntimeGardenComputeConfig,
  secretRef: string
): RuntimeGardenComputeConfig {
  return RuntimeGardenComputeConfigSchema.parse({
    ...current,
    secret_ref: secretRef
  });
}

async function appendPersistedGardenConfigSecretRefChange(
  database: ReturnType<typeof initDatabase>,
  configRepo: SqliteConfigRepo,
  after: RuntimeGardenComputeConfig,
  occurredAt: string
): Promise<void> {
  const eventPublisher = createPersistedGardenConfigEventPublisher(database);
  await eventPublisher.appendManyWithMutation(
    [buildPersistedGardenConfigAuditEntry(occurredAt)],
    () => {
      configRepo.setParsed(RUNTIME_GARDEN_COMPUTE_CONFIG_KEY, after, RuntimeGardenComputeConfigSchema);
      return after;
    }
  );
}

function createPersistedGardenConfigEventPublisher(database: ReturnType<typeof initDatabase>) {
  return new EventPublisher({
    eventLogRepo: new SqliteEventLogRepo(database),
    runHotStateService: { apply: () => undefined },
    runtimeNotifier: {
      notify: () => undefined,
      notifyEntry: () => undefined
    }
  });
}

function buildPersistedGardenConfigAuditEntry(occurredAt: string) {
  return {
    event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
    entity_type: "runtime_config",
    entity_id: RUNTIME_GARDEN_COMPUTE_CONFIG_KEY,
    workspace_id: "runtime",
    run_id: null,
    caused_by: "install",
    payload_json: SoulHealthJournalRecordedPayloadSchema.parse({
      entry_id: `install-keychain:${occurredAt}`,
      event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
      workspace_id: "runtime",
      occurred_at: occurredAt,
      change_summary: {
        fields_changed: ["secret_ref"],
        secret_ref_kind: "keychain"
      }
    })
  };
}
