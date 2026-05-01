import { randomUUID } from "node:crypto";
import { CoreError } from "@do-soul/alaya-core";
import {
  DEFAULT_ENVIRONMENT_CONFIG,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  EnvironmentConfigSchema,
  HealthEventKind,
  Phase4AEventType,
  RuntimeEmbeddingConfigSchema,
  SoulConfigSchema,
  SoulHealthJournalRecordedPayloadSchema,
  StrategyConfigSchema,
  type EnvironmentConfig,
  type EventLogEntry,
  type RuntimeEmbeddingConfig,
  type SoulConfig,
  type StrategyConfig
} from "@do-soul/alaya-protocol";
import type { ConfigRepo } from "@do-soul/alaya-storage";
import type { AlayaConfigPaths } from "../cli/config-files.js";
import {
  applyRuntimeEmbeddingConfigFiles,
  normalizeRuntimeEmbeddingConfigPatch,
  type NormalizedRuntimeEmbeddingConfigPatch
} from "./env-file-service.js";

export interface AppConfigService {
  getSoulConfig(workspaceId: string): Promise<SoulConfig>;
  patchSoulConfig(workspaceId: string, patch: unknown): Promise<SoulConfig>;
  getStrategyConfig(workspaceId: string): Promise<StrategyConfig>;
  patchStrategyConfig(workspaceId: string, patch: unknown): Promise<StrategyConfig>;
  getEnvironmentConfig(workspaceId: string): Promise<EnvironmentConfig>;
  patchEnvironmentConfig(workspaceId: string, patch: unknown): Promise<EnvironmentConfig>;
  getRuntimeEmbeddingConfig(): Promise<RuntimeEmbeddingConfig>;
  patchRuntimeEmbeddingConfig(patch: unknown): Promise<RuntimeEmbeddingConfig>;
}

interface ConfigEventPublisher {
  publishWithMutation<T>(
    eventInput: Omit<EventLogEntry, "event_id" | "created_at">,
    mutate: (entry: EventLogEntry) => Promise<T>
  ): Promise<T>;
}

const SoulConfigPatchSchema = SoulConfigSchema.unwrap().partial();
const StrategyConfigPatchSchema = StrategyConfigSchema.unwrap().partial();
const EnvironmentConfigPatchSchema = EnvironmentConfigSchema.unwrap().partial();

const RUNTIME_EMBEDDING_CONFIG_KEY = "runtime:embedding-supplement";
const RUNTIME_EMBEDDING_ENTITY_TYPE = "runtime_config";
const RUNTIME_EMBEDDING_ENTITY_ID = "runtime:embedding-supplement";
const RUNTIME_CONFIG_WORKSPACE_ID = "runtime";
const DEFAULT_REVISION = 0;
const RUNTIME_EMBEDDING_CONFIG_FIELDS = [
  "provider_url",
  "secret_ref",
  "model_id",
  "embedding_enabled"
] as const;

const DEFAULT_RUNTIME_EMBEDDING_CONFIG: RuntimeEmbeddingConfig = {
  provider_url: null,
  secret_ref: null,
  model_id: null,
  embedding_enabled: false
};

export function createConfigService(dependencies: {
  readonly configRepo: ConfigRepo;
  readonly eventPublisher: ConfigEventPublisher;
  readonly configPathsProvider: () => AlayaConfigPaths;
  readonly clock?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly generateTempId?: () => string;
  readonly generateAuditId?: () => string;
}): AppConfigService {
  const {
    configRepo,
    eventPublisher,
    configPathsProvider,
    clock = () => new Date().toISOString(),
    platform = process.platform,
    generateTempId = () => randomUUID(),
    generateAuditId = () => randomUUID()
  } = dependencies;

  return {
    getSoulConfig: async (workspaceId) =>
      await getSectionConfig(configRepo, keyFor(workspaceId, "soul"), SoulConfigSchema, DEFAULT_SOUL_CONFIG),
    patchSoulConfig: async (workspaceId, patch) =>
      await patchSectionConfig(
        configRepo,
        keyFor(workspaceId, "soul"),
        SoulConfigSchema,
        SoulConfigPatchSchema,
        DEFAULT_SOUL_CONFIG,
        patch,
        "Invalid soul config patch"
      ),
    getStrategyConfig: async (workspaceId) =>
      await getSectionConfig(configRepo, keyFor(workspaceId, "strategy"), StrategyConfigSchema, DEFAULT_STRATEGY_CONFIG),
    patchStrategyConfig: async (workspaceId, patch) =>
      await patchSectionConfig(
        configRepo,
        keyFor(workspaceId, "strategy"),
        StrategyConfigSchema,
        StrategyConfigPatchSchema,
        DEFAULT_STRATEGY_CONFIG,
        patch,
        "Invalid strategy config patch"
      ),
    getEnvironmentConfig: async (workspaceId) =>
      await getSectionConfig(
        configRepo,
        keyFor(workspaceId, "environment"),
        EnvironmentConfigSchema,
        DEFAULT_ENVIRONMENT_CONFIG
      ),
    patchEnvironmentConfig: async (workspaceId, patch) =>
      await patchSectionConfig(
        configRepo,
        keyFor(workspaceId, "environment"),
        EnvironmentConfigSchema,
        EnvironmentConfigPatchSchema,
        DEFAULT_ENVIRONMENT_CONFIG,
        patch,
        "Invalid environment config patch"
      ),
    getRuntimeEmbeddingConfig: async () =>
      await getRuntimeEmbeddingConfig(configRepo),
    patchRuntimeEmbeddingConfig: async (patch) =>
      await patchRuntimeEmbeddingConfig({
        repo: configRepo,
        eventPublisher,
        paths: configPathsProvider(),
        patch,
        clock,
        platform,
        generateTempId,
        generateAuditId
      })
  };
}

function keyFor(workspaceId: string, section: "soul" | "strategy" | "environment"): string {
  return `workspace:${workspaceId}:${section}`;
}

async function getSectionConfig<T>(
  repo: ConfigRepo,
  key: string,
  schema: { parse(value: unknown): T },
  defaults: T
): Promise<T> {
  const raw = await repo.get<T>(key);
  return schema.parse(raw ?? defaults);
}

async function patchSectionConfig<T extends Record<string, unknown>>(
  repo: ConfigRepo,
  key: string,
  fullSchema: { parse(value: unknown): T },
  patchSchema: { safeParse(value: unknown): { success: true; data: Partial<T> } | { success: false; error: unknown } },
  defaults: T,
  patch: unknown,
  validationMessage: string
): Promise<T> {
  const parsedPatch = patchSchema.safeParse(patch);

  if (!parsedPatch.success) {
    throw new CoreError("VALIDATION", validationMessage, { cause: parsedPatch.error });
  }

  const next = await repo.patch(key, parsedPatch.data, defaults);
  return fullSchema.parse(next);
}

async function getRuntimeEmbeddingConfig(repo: ConfigRepo): Promise<RuntimeEmbeddingConfig> {
  return RuntimeEmbeddingConfigSchema.parse(
    (await repo.get<RuntimeEmbeddingConfig>(RUNTIME_EMBEDDING_CONFIG_KEY)) ??
      DEFAULT_RUNTIME_EMBEDDING_CONFIG
  );
}

async function patchRuntimeEmbeddingConfig(input: {
  readonly repo: ConfigRepo;
  readonly eventPublisher: ConfigEventPublisher;
  readonly paths: AlayaConfigPaths;
  readonly patch: unknown;
  readonly clock: () => string;
  readonly platform: NodeJS.Platform;
  readonly generateTempId: () => string;
  readonly generateAuditId: () => string;
}): Promise<RuntimeEmbeddingConfig> {
  const normalized = normalizeRuntimeEmbeddingConfigPatch(input.patch, input.paths, input.platform);
  const occurredAt = parseIsoTimestamp(input.clock());
  const auditEntryId = input.generateAuditId();

  return await input.eventPublisher.publishWithMutation(
    {
      event_type: Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED,
      entity_type: RUNTIME_EMBEDDING_ENTITY_TYPE,
      entity_id: RUNTIME_EMBEDDING_ENTITY_ID,
      workspace_id: RUNTIME_CONFIG_WORKSPACE_ID,
      run_id: null,
      caused_by: "inspector",
      revision: DEFAULT_REVISION,
      payload_json: SoulHealthJournalRecordedPayloadSchema.parse({
        entry_id: auditEntryId,
        event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
        workspace_id: RUNTIME_CONFIG_WORKSPACE_ID,
        occurred_at: occurredAt,
        change_summary: buildRuntimeEmbeddingChangeSummary(normalized)
      })
    },
    async () =>
      await applyRuntimeEmbeddingConfigFiles({
        paths: input.paths,
        normalized,
        generateTempId: input.generateTempId,
        persist: async () => {
          const next = await input.repo.patch(
            RUNTIME_EMBEDDING_CONFIG_KEY,
            normalized.patch,
            DEFAULT_RUNTIME_EMBEDDING_CONFIG
          );
          return RuntimeEmbeddingConfigSchema.parse(next);
        }
      })
  );
}

function buildRuntimeEmbeddingChangeSummary(normalized: NormalizedRuntimeEmbeddingConfigPatch): {
  readonly fields_changed: readonly string[];
  readonly secret_ref_kind?: "env" | "file" | null;
} {
  const fieldsChanged = RUNTIME_EMBEDDING_CONFIG_FIELDS.filter((field) => normalized.patch[field] !== undefined);
  return {
    fields_changed: fieldsChanged,
    ...(normalized.patch.secret_ref !== undefined ? { secret_ref_kind: secretRefKind(normalized.patch.secret_ref) } : {})
  };
}

function secretRefKind(secretRef: string | null): "env" | "file" | null {
  if (secretRef === null) {
    return null;
  }
  return secretRef.startsWith("env:") ? "env" : "file";
}

function parseIsoTimestamp(value: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new CoreError("VALIDATION", "Invalid runtime embedding config patch");
  }
  return value;
}
