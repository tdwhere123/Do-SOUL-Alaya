import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SignalEventType, type EventLogEntry, type PathRelation } from "@do-soul/alaya-protocol";
import { EventPublisher, RelationAssertionService, stableStringify } from "@do-soul/alaya-core";
import {
  digestRelationFormationEventSource,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteRelationAssertionRepo,
  SqliteRunRepo,
  SqliteSoftAssociationPathRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createBoundRecallPathReadPorts } from "../../../runtime/recall/recall-path-read-bind.js";
import { createRecallTemporalProjectionEnsurer } from "../../../runtime/recall/recall-path-readers.js";
import {
  closeDaemonSqliteWriteQueue,
  openDaemonDatabase
} from "../../../runtime/startup/database.js";

const builtWorkerUrl = new URL("../../../../dist/runtime/recall/recall-read-worker.js", import.meta.url);
const sourceMemoryId = "11111111-1111-4111-8111-111111111111";
const targetMemoryId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "workspace-temporal";

describe("selected temporal recall read worker", () => {
  beforeAll(() => {
    if (!existsSync(fileURLToPath(builtWorkerUrl))) {
      throw new Error("Built recall-read-worker dist missing. Run `rtk pnpm build` before this test.");
    }
  });

  it("reads bounded event-time windows through the worker memory port", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-event-window-test-"));
    const databasePath = join(directory, "alaya.db");
    const database = await openDaemonDatabase(databasePath);
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const memoryRepo = new SqliteMemoryEntryRepo(database);

    try {
      workspaceRepo.create({
        workspace_id: workspaceId,
        name: "Event window worker test",
        root_path: directory,
        workspace_kind: "local_repo",
        repo_path: directory,
        default_engine_binding: null,
        workspace_state: "active"
      });
      await memoryRepo.create({
        ...createMemoryEntry(sourceMemoryId, "Outside event"),
        event_time_start: "2026-06-01T00:00:00.000Z"
      });
      await memoryRepo.create({
        ...createMemoryEntry(targetMemoryId, "Requested event"),
        event_time_start: "2026-06-15T00:00:00.000Z",
        event_time_end: "2026-06-16T00:00:00.000Z"
      });
      database.close();

      const client = createRecallReadWorkerClient({
        databaseFilename: databasePath,
        workerUrl: builtWorkerUrl
      });
      expect(client).not.toBeNull();
      if (client === null) return;
      try {
        const result = await client.memoryRepo.findByEventTimeWindow!({
          workspaceId,
          tier: "hot",
          startTime: "2026-06-14T00:00:00.000Z",
          endTime: "2026-06-17T00:00:00.000Z",
          limit: 10
        });
        expect(result.map((entry) => entry.object_id)).toEqual([targetMemoryId]);
      } finally {
        await client.close();
      }
    } finally {
      if (!database.isClosed()) {
        database.close();
      }
      await closeDaemonSqliteWriteQueue();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps governed soft associations consistent across direct and worker path reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-temporal-test-"));
    const databasePath = join(directory, "alaya.db");
    const database = await openDaemonDatabase(databasePath);
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    const pathRelationRepo = new SqlitePathRelationRepo(database);

    try {
      workspaceRepo.create({
        workspace_id: workspaceId,
        name: "Temporal worker test",
        root_path: directory,
        workspace_kind: "local_repo",
        repo_path: directory,
        default_engine_binding: null,
        workspace_state: "active"
      });
      await memoryRepo.create(createMemoryEntry(sourceMemoryId, "Temporal source memory"));
      await memoryRepo.create(createMemoryEntry(targetMemoryId, "Temporal target memory"));
      pathRelationRepo.create(createLegacyPathRelation());
      const softAssociation = createSoftAssociationPathRelation();
      new SqliteSoftAssociationPathRepo(database).create(softAssociation);
      await expect(createBoundRecallPathReadPorts({
        database,
        pathReadBind: "temporal"
      }).pathExpansionPort.findByAnchors(workspaceId, [
        { kind: "object", object_id: sourceMemoryId }
      ])).resolves.toEqual([softAssociation]);
      database.close();

      expect(() => createRecallReadWorkerClient({
        databaseFilename: databasePath,
        pathReadBind: "temporal",
        workerUrl: builtWorkerUrl
      })).toThrow("selected temporal recall worker requires parent projection preparation");

      const selectedClient = createRecallReadWorkerClient({
        databaseFilename: databasePath,
        pathReadBind: "temporal",
        prepareTemporalProjection: async () => undefined,
        workerUrl: builtWorkerUrl
      });
      expect(selectedClient).not.toBeNull();
      if (selectedClient === null) return;
      try {
        await expect(selectedClient.pathExpansionPort.findByAnchors(workspaceId, [
          { kind: "object", object_id: sourceMemoryId }
        ])).resolves.toEqual([softAssociation]);
      } finally {
        await selectedClient.close();
      }
    } finally {
      if (!database.isClosed()) {
        database.close();
      }
      await closeDaemonSqliteWriteQueue();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds selected current and exact as-of projections before worker reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-temporal-rebuild-test-"));
    const databasePath = join(directory, "alaya.db");
    const database = await openDaemonDatabase(databasePath);
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
    const relationAssertionRepo = new SqliteRelationAssertionRepo(database);
    const relationAssertionService = new RelationAssertionService({
      repo: relationAssertionRepo,
      eventPublisher: new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: () => undefined },
        runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
      }),
      eventHistory: eventLogRepo,
      now: () => "2026-07-17T02:00:00.000Z"
    });
    const prepareTemporalProjection = createRecallTemporalProjectionEnsurer(
      relationAssertionService
    );
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    const historicalAsOf = "2026-07-17T01:30:00.000Z";

    try {
      workspaceRepo.create({
        workspace_id: workspaceId,
        name: "Temporal worker rebuild test",
        root_path: directory,
        workspace_kind: "local_repo",
        repo_path: directory,
        default_engine_binding: null,
        workspace_state: "active"
      });
      await new SqliteRunRepo(database).create({
        run_id: "run-temporal-worker",
        workspace_id: workspaceId,
        title: "Temporal worker projection test",
        goal: null,
        run_mode: "chat",
        engine_binding_id: null,
        engine_class: null,
        run_state: "idle",
        current_surface_id: null
      });
      const sourceEvent = await eventLogRepo.append({
        event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
        entity_type: "candidate_memory_signal",
        entity_id: "signal-temporal-worker",
        workspace_id: workspaceId,
        run_id: "run-temporal-worker",
        caused_by: "garden",
        payload_json: { source: "test" }
      });
      await evidenceRepo.create({
        object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
        object_kind: "evidence_capsule",
        schema_version: 1,
        lifecycle_state: "active",
        created_at: "2026-07-17T01:00:00.000Z",
        updated_at: "2026-07-17T01:00:00.000Z",
        created_by: "garden",
        evidence_kind: "conversation_excerpt",
        semantic_anchor: { topic: "temporal", keywords: ["temporal"], summary: "source" },
        event_anchor: {
          event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
          event_id: sourceEvent.event_id,
          occurred_at: "2026-07-17T01:00:00.000Z"
        },
        physical_anchor: null,
        evidence_health_state: "verified",
        gist: "source",
        excerpt: "source",
        source_hash: null,
        run_id: "run-temporal-worker",
        workspace_id: workspaceId,
        surface_id: null
      });
      await relationAssertionService.admit({
        assertionId: "assertion-selected-worker",
        workspaceId,
        runId: "run-temporal-worker",
        causedBy: "garden",
        ...relationReceipt(
          "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
          sourceEvent,
          "2026-07-17T01:00:00.000Z"
        ),
        anchors: {
          source_anchor: { kind: "object", object_id: sourceMemoryId },
          target_anchor: { kind: "object", object_id: targetMemoryId }
        },
        relationKind: "supports",
        validity: { kind: "open", valid_from: "2026-07-17T01:00:00.000Z" },
        admittedAt: "2026-07-17T01:00:00.000Z"
      });
      await relationAssertionService.resolve({
        assertionId: "assertion-selected-worker",
        workspaceId,
        runId: "run-temporal-worker",
        causedBy: "garden",
        resolutionKind: "retracted",
        reason: "historical worker test resolution",
        resolvedAt: "2026-07-17T01:45:00.000Z"
      });
      const selectedClient = createRecallReadWorkerClient({
        databaseFilename: databasePath,
        pathReadBind: "temporal",
        prepareTemporalProjection,
        workerUrl: builtWorkerUrl
      });
      expect(selectedClient).not.toBeNull();
      if (selectedClient === null) return;
      try {
        await expect(selectedClient.pathExpansionPort.findByAnchors(workspaceId, [
          { kind: "object", object_id: sourceMemoryId }
        ])).resolves.toEqual([]);
        const historicalRead = selectedClient.pathExpansionPort.findByAnchors(
          workspaceId,
          [{ kind: "object", object_id: sourceMemoryId }],
          { asOf: historicalAsOf }
        );
        const parentWrite = memoryRepo.create(createMemoryEntry(
          "33333333-3333-4333-8333-333333333333",
          "Parent write while worker reads"
        ));
        const [historicalPaths, writtenMemory] = await Promise.all([
          historicalRead,
          parentWrite
        ]);
        expect(historicalPaths).toMatchObject([{ path_id: "assertion-selected-worker" }]);
        expect(writtenMemory.object_id).toBe("33333333-3333-4333-8333-333333333333");
      } finally {
        await selectedClient.close();
      }
    } finally {
      if (!database.isClosed()) {
        database.close();
      }
      await closeDaemonSqliteWriteQueue();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function relationReceipt(evidenceId: string, event: Readonly<EventLogEntry>, occurredAt: string) {
  const parameters = { relation_kind: "supports" };
  const decision = { evidence_id: evidenceId, source_event_id: event.event_id };
  return {
    evidenceReceipts: [{
      evidence_id: evidenceId,
      source_event_anchor: {
        event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
        event_id: event.event_id,
        occurred_at: occurredAt
      }
    }],
    formationReceipt: {
      operator_id: "temporal_worker_test_v1",
      operator_sha256: "a".repeat(64),
      parameters,
      parameter_sha256: relationDigest(parameters),
      source_observations: [{
        source_kind: "event_log_entry" as const,
        source_id: event.event_id,
        source_sha256: digestRelationFormationEventSource(event)
      }],
      decision,
      decision_sha256: relationDigest(decision)
    }
  };
}

function relationDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function createMemoryEntry(objectId: string, content: string) {
  return {
    object_id: objectId,
    object_kind: "memory_entry" as const,
    schema_version: 1,
    lifecycle_state: "active" as const,
    created_at: "2026-06-17T00:00:00.000Z",
    updated_at: "2026-06-17T00:00:00.000Z",
    created_by: "test",
    dimension: "procedure" as const,
    source_kind: "user" as const,
    formation_kind: "explicit" as const,
    scope_class: "project" as const,
    content,
    domain_tags: ["recall"],
    evidence_refs: [],
    workspace_id: workspaceId,
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot" as const,
    activation_score: 1,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}

function createLegacyPathRelation(): PathRelation {
  return {
    path_id: "legacy-path-temporal",
    workspace_id: workspaceId,
    anchors: {
      source_anchor: { kind: "object", object_id: sourceMemoryId },
      target_anchor: { kind: "object", object_id: targetMemoryId }
    },
    constitution: {
      relation_kind: "co_usage",
      why_this_relation_exists: ["legacy worker fixture"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: 1,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 1,
      direction_bias: "bidirectional_asymmetric",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0,
      last_reinforced_at: "2026-07-17T00:00:00.000Z"
    },
    lifecycle: {
      status: "active",
      retirement_rule: "janitor_ttl_low_strength"
    },
    legitimacy: {
      evidence_basis: ["evidence-temporal"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z"
  };
}

function createSoftAssociationPathRelation(): PathRelation {
  return {
    ...createLegacyPathRelation(),
    path_id: "soft-association-worker",
    constitution: {
      relation_kind: "co_recalled",
      why_this_relation_exists: ["earned co-recall"]
    },
    legitimacy: {
      evidence_basis: ["recalls_edge_co_usage"],
      governance_class: "attention_only"
    }
  };
}
