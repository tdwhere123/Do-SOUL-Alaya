import { FormationKind, GardenRole, SoulGardenSemanticEnrichmentPayloadSchema, MemoryDimension, ScopeClass, SourceKind,
  type SemanticEnrichmentTask,
  type SemanticExtractionProfile } from "@do-soul/alaya-protocol";
import { OfficialApiSemanticArtifactCodec } from "@do-soul/alaya-soul";
import { initializeSemanticArtifactCandidateSchema, SqliteSemanticArtifactRepo,
  SqliteGardenTaskRepo, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo,
  type StorageDatabase } from "@do-soul/alaya-storage";
import { SemanticEnrichmentWorker, type SemanticEnrichmentWorkerDependencies } from
  "../../../conversation/semantic-enrichment-worker.js";
import { MemoryService } from "../../../memory/memory-service.js";
import { EventPublisher } from "../../../runtime/event-publisher.js";
import { createSliceHarness } from "./harness.js";
import { NOW, WS, RUN } from "./ids.js";

export const PROFILE: SemanticExtractionProfile = Object.freeze({ capability: 'official_api_signals:v1',
  model: 'external-transport-fixture', requestProfile: 'logical-request-v1',
  promptRevision: 'fixture-prompt-v1', outputSchema: 'official-api-signals-v1' });

export function response(logicalRequestJson: string): string {
  const unit = JSON.parse(logicalRequestJson) as { text: string };
  return JSON.stringify({ signals: [{ object_kind: 'decision', confidence: 0.8,
    matched_text: unit.text, distilled_fact: unit.text }] });
}

export function wireArtifacts(database: StorageDatabase) {
  const events = new SqliteEventLogRepo(database);
  const publisher = new EventPublisher({ eventLogRepo: events,
    runHotStateService: { apply: () => {} }, runtimeNotifier: { notify: async () => {}, notifyEntry: async () => {} } });
  const garden = new SqliteGardenTaskRepo(database.connection, publisher);
  const repo = new SqliteSemanticArtifactRepo(database.connection, garden, PROFILE);
  const codec = new OfficialApiSemanticArtifactCodec();
  let now = NOW;
  const audit = <T>(action: string, task: SemanticEnrichmentTask, mutate: () => T) =>
    publisher.appendManyWithMutation([{ event_type: "soul.garden.semantic_enrichment",
      entity_type: 'garden_task', entity_id: task.id, workspace_id: task.workspaceId,
      run_id: RUN, caused_by: 'garden', payload_json: SoulGardenSemanticEnrichmentPayloadSchema.parse({ task_id: task.id, source_revision: task.revision, action }) }], mutate);
  function worker(transport: SemanticEnrichmentWorkerDependencies['transport'],
    auditOverride = audit, maxAttempts = 3, maxReservedUtf8Bytes = 32 * 16_384,
    maxCompletionUtf8Bytes?: number) {
    return new SemanticEnrichmentWorker({ repo, codec, transport, audit: auditOverride,
      now: () => now, leaseMs: 1000, maxAttempts, maxUnits: 32, transportTimeoutMs: 100, maxLocalRecoveries: 8,
      maxReservedUtf8Bytes,
      ...(maxCompletionUtf8Bytes === undefined ? {} : { maxCompletionUtf8Bytes }) });
  }
  return { events, garden, repo, codec, audit, worker,
    advance: () => { now = new Date(Date.parse(now) + 2000).toISOString(); } };
}

export async function artifactFixture(register: (database: StorageDatabase) => void, filename = ':memory:') {
  const slice = await createSliceHarness(register, filename);
  initializeSemanticArtifactCandidateSchema(slice.database.connection);
  const wired = wireArtifacts(slice.database);
  const evidence = new SqliteEvidenceCapsuleRepo(slice.database);
  let nextId = '';
  let rejectEnqueue = false;
  const writeDurations: number[] = [];
  const memory = new MemoryService({ now: () => NOW, generateObjectId: () => nextId,
    eventLogRepo: wired.events, memoryEntryRepo: slice.memoryEntryRepo,
    evidenceService: { findById: async (id) => evidence.findById(id),
      findByIds: async (workspaceId, ids) => evidence.findByIds?.(workspaceId, ids) ?? [] },
    gardenIntentPort: rejectableGarden(wired.garden, () => rejectEnqueue),
    runtimeNotifier: { notifyEntry: async () => {} } });
  function latestIntent(objectId: string): string {
    const pending = wired.garden.peekPending(GardenRole.LIBRARIAN, WS, 128);
    const match = [...pending].reverse().find((row) => {
      const payload = row.payload as { source_object_id?: string };
      return payload.source_object_id === objectId;
    });
    if (match === undefined) throw new Error(`missing source enrichment intent for ${objectId}`);
    return match.id;
  }
  async function write(id: string, content: string) {
    nextId = id;
    const started = performance.now();
    await memory.create({ created_by: 'user_action', dimension: MemoryDimension.PROCEDURE,
      source_kind: SourceKind.USER, formation_kind: FormationKind.EXPLICIT,
      scope_class: ScopeClass.PROJECT, content, domain_tags: [], evidence_refs: [],
      workspace_id: WS, run_id: RUN, surface_id: null,
      enqueueEnrichment: { runId: RUN, sourceSignalId: null } });
    writeDurations.push(performance.now() - started);
    return latestIntent(id);
  }
  async function change(id: string, content: string) {
    const started = performance.now();
    await memory.updateScoped(id, WS, { content }, 'source revision', { runId: RUN, sourceSignalId: null });
    writeDurations.push(performance.now() - started);
    return latestIntent(id);
  }
  return { slice, ...wired, memory, write, change, writeDurations,
    rejectEnqueue: () => { rejectEnqueue = true; }, enqueue: (id: string, profile = PROFILE) =>
    slice.database.connection.transaction(() => wired.repo.enqueue(WS, id, profile, NOW))() };
}

function rejectableGarden(
  garden: SqliteGardenTaskRepo,
  rejected: () => boolean
): SqliteGardenTaskRepo {
  return new Proxy(garden, {
    get(target, property, receiver) {
      if (property === 'enqueue' && rejected()) {
        return () => {
          throw new Error('retryable semantic enrichment backpressure');
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
