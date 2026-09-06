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
  defaultSourceEnrichmentProfile
} from "@do-soul/alaya-soul";
import {
  SqliteSemanticArtifactRepo,
  initializeSemanticArtifactCandidateSchema,
  type SqliteGardenTaskRepo
} from "@do-soul/alaya-storage";

export function createSourceEnrichmentRuntime(input: Readonly<{
  readonly connection: unknown;
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly eventPublisher: EventPublisher;
  readonly now: () => string;
  readonly transport?: SemanticEnrichmentWorkerDependencies["transport"];
  readonly profile?: SemanticExtractionProfile;
}>): { run(task: Readonly<GardenTaskDescriptor>): Promise<string> } | undefined {
  if (input.gardenTaskRepo === undefined || !canHostSemanticArtifacts(input.connection)) {
    return undefined;
  }
  const connection = input.connection as ConstructorParameters<typeof SqliteSemanticArtifactRepo>[0];
  initializeSemanticArtifactCandidateSchema(connection);
  const profile = input.profile ?? defaultSourceEnrichmentProfile();
  const repo = new SqliteSemanticArtifactRepo(connection, input.gardenTaskRepo, profile);
  const codec = new OfficialApiSemanticArtifactCodec();
  const transport = input.transport ?? failClosedTransport();
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
    transportTimeoutMs: 20_000,
    maxLocalRecoveries: 8
  });
  return {
    run: async (task) => await worker.run(task.workspace_id, task.task_id, { adoptClaim: true })
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

function failClosedTransport(): SemanticEnrichmentWorkerDependencies["transport"] {
  return {
    execute: async () => {
      throw new Error("semantic logical transport is not composed");
    },
    reconcile: async () => ({ kind: "unknown" })
  };
}
