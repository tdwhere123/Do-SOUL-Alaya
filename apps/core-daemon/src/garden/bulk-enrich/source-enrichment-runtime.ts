import {
  SemanticEnrichmentWorker,
  type EventPublisher,
  type SemanticEnrichmentWorkerDependencies
} from "@do-soul/alaya-core";
import {
  GardenEventType,
  SoulGardenSemanticEnrichmentPayloadSchema,
  type GardenTaskDescriptor,
  type SemanticExtractionProfile
} from "@do-soul/alaya-protocol";
import {
  OfficialApiSemanticArtifactCodec,
  OFFICIAL_API_SYSTEM_PROMPT,
  defaultSourceEnrichmentProfile
} from "@do-soul/alaya-soul";
import {
  SqliteSemanticArtifactRepo,
  initializeSemanticArtifactCandidateSchema,
  type SqliteGardenTaskRepo
} from "@do-soul/alaya-storage";

export type SemanticProviderExtractPort = Readonly<{
  extract(input: {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly abortSignal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<{ readonly rawJson: string }>;
}>;

export type SourceEnrichmentCapability = Readonly<{
  readonly configured: boolean;
  readonly observationFamily: "official_api_signals" | "none";
  readonly requestBytes: "reserved";
  readonly completionTokens: "unsupported";
  readonly spend: "unsupported";
}>;

export type SourceEnrichmentRuntime = Readonly<{
  run(task: Readonly<GardenTaskDescriptor>): Promise<string>;
  readonly capability: SourceEnrichmentCapability;
}>;

export function createSourceEnrichmentRuntime(input: Readonly<{
  readonly connection: unknown;
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly eventPublisher: EventPublisher;
  readonly now: () => string;
  readonly transport?: SemanticEnrichmentWorkerDependencies["transport"];
  readonly provider?: SemanticProviderExtractPort;
  readonly profile?: SemanticExtractionProfile;
  readonly transportTimeoutMs?: number;
  readonly maxReservedUtf8Bytes?: number;
  readonly maxCompletionUtf8Bytes?: number;
}>): SourceEnrichmentRuntime | undefined {
  if (input.gardenTaskRepo === undefined || !canHostSemanticArtifacts(input.connection)) {
    return undefined;
  }
  const connection = input.connection as ConstructorParameters<typeof SqliteSemanticArtifactRepo>[0];
  initializeSemanticArtifactCandidateSchema(connection);
  const profile = input.profile ?? defaultSourceEnrichmentProfile();
  const repo = new SqliteSemanticArtifactRepo(connection, input.gardenTaskRepo, profile);
  const codec = new OfficialApiSemanticArtifactCodec();
  const transportTimeoutMs = input.transportTimeoutMs ?? 20_000;
  const maxReservedUtf8Bytes = input.maxReservedUtf8Bytes ?? 262_144;
  const maxCompletionUtf8Bytes = input.maxCompletionUtf8Bytes ?? 262_144;
  const transport = composeRuntimeTransport(input, { transportTimeoutMs, maxCompletionUtf8Bytes });
  const capability = describeCapability(input, transport);
  const worker = new SemanticEnrichmentWorker({
    repo,
    codec,
    transport,
    audit: (action, task, mutate) => input.eventPublisher.appendManyWithMutation([{
      event_type: GardenEventType.SOUL_GARDEN_SEMANTIC_ENRICHMENT,
      entity_type: "garden_task",
      entity_id: task.id,
      workspace_id: task.workspaceId,
      run_id: null,
      caused_by: "garden",
      payload_json: SoulGardenSemanticEnrichmentPayloadSchema.parse({
        task_id: task.id, source_revision: task.revision, action
      })
    }], mutate),
    now: input.now,
    leaseMs: 30_000,
    maxAttempts: 3,
    maxUnits: 32,
    transportTimeoutMs,
    maxLocalRecoveries: 8,
    maxReservedUtf8Bytes,
    maxCompletionUtf8Bytes
  });
  return {
    capability,
    run: async (task) => await worker.run(task.workspace_id, task.task_id, { adoptClaim: true })
  };
}

function composeRuntimeTransport(input: Readonly<{
  readonly transport?: SemanticEnrichmentWorkerDependencies["transport"];
  readonly provider?: SemanticProviderExtractPort;
}>, limits: {
  readonly transportTimeoutMs: number;
  readonly maxCompletionUtf8Bytes: number;
}): SemanticEnrichmentWorkerDependencies["transport"] {
  if (input.provider !== undefined) {
    return SemanticEnrichmentWorker.composeProviderTransport(input.provider, {
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      timeoutMs: limits.transportTimeoutMs,
      maxCompletionUtf8Bytes: limits.maxCompletionUtf8Bytes
    });
  }
  if (input.transport !== undefined) return input.transport;
  return SemanticEnrichmentWorker.composeProviderTransport(undefined);
}

function describeCapability(input: Readonly<{
  readonly transport?: SemanticEnrichmentWorkerDependencies["transport"];
  readonly provider?: SemanticProviderExtractPort;
}>, transport: SemanticEnrichmentWorkerDependencies["transport"]): SourceEnrichmentCapability {
  const configured = input.provider !== undefined ||
    (input.transport !== undefined && transport.capabilities?.configured !== false);
  return {
    configured,
    observationFamily: configured ? "official_api_signals" : "none",
    requestBytes: "reserved",
    completionTokens: "unsupported",
    spend: "unsupported"
  };
}

function canHostSemanticArtifacts(connection: unknown): boolean {
  const db = connection as {
    readonly exec?: unknown;
    readonly transaction?: unknown;
    readonly function?: unknown;
    readonly prepare?: unknown;
  };
  return [db.exec, db.transaction, db.function, db.prepare].every((value) => typeof value === "function");
}
