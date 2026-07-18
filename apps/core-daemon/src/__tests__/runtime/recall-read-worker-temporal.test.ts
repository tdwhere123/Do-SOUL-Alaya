import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SignalEventType, type PathRelation } from "@do-soul/alaya-protocol";
import { EventPublisher, RelationAssertionService } from "@do-soul/alaya-core";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteRelationAssertionRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { createRecallReadWorkerClient } from "../../runtime/recall-read-worker-client.js";
import { createRecallTemporalProjectionEnsurer } from "../../runtime/recall-path-readers.js";
import { openDaemonDatabase } from "../../runtime/startup/database.js";

const builtWorkerUrl = new URL("../../../dist/runtime/recall-read-worker.js", import.meta.url);
const sourceMemoryId = "11111111-1111-4111-8111-111111111111";
const targetMemoryId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "workspace-temporal";

describe("selected temporal recall read worker", () => {
  beforeAll(() => {
    if (!existsSync(fileURLToPath(builtWorkerUrl))) {
      throw new Error("Built recall-read-worker dist missing. Run `rtk pnpm build` before this test.");
    }
  });

  it("uses only the selected temporal projection for worker path reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-temporal-test-"));
    const databasePath = join(directory, "alaya.db");
    const database = openDaemonDatabase(databasePath);
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
      database.close();

      const legacyClient = createRecallReadWorkerClient({
        databaseFilename: databasePath,
        temporalProjectionSelected: false,
        workerUrl: builtWorkerUrl
      });
      expect(legacyClient).not.toBeNull();
      if (legacyClient === null) return;
      try {
        await expect(legacyClient.pathExpansionPort.findByAnchors(workspaceId, [
          { kind: "object", object_id: sourceMemoryId }
        ])).resolves.toMatchObject([{ path_id: "legacy-path-temporal" }]);
      } finally {
        await legacyClient.close();
      }

      expect(() => createRecallReadWorkerClient({
        databaseFilename: databasePath,
        temporalProjectionSelected: true,
        workerUrl: builtWorkerUrl
      })).toThrow("selected temporal recall worker requires parent projection preparation");

      const selectedClient = createRecallReadWorkerClient({
        databaseFilename: databasePath,
        temporalProjectionSelected: true,
        prepareTemporalProjection: async () => undefined,
        workerUrl: builtWorkerUrl
      });
      expect(selectedClient).not.toBeNull();
      if (selectedClient === null) return;
      try {
        await expect(selectedClient.pathExpansionPort.findByAnchors(workspaceId, [
          { kind: "object", object_id: sourceMemoryId }
        ])).resolves.toEqual([]);
      } finally {
        await selectedClient.close();
      }
    } finally {
      if (!database.isClosed()) {
        database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rebuilds selected current and exact as-of projections before worker reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-temporal-rebuild-test-"));
    const databasePath = join(directory, "alaya.db");
    const database = openDaemonDatabase(databasePath);
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
      const sourceEvent = eventLogRepo.append({
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
        evidenceIds: ["85b3671a-d8d8-4848-9e5c-07d0a89f5ae9"],
        anchors: {
          source_anchor: { kind: "object", object_id: sourceMemoryId },
          target_anchor: { kind: "object", object_id: targetMemoryId }
        },
        relationKind: "supports",
        validity: { kind: "open", valid_from: "2026-07-17T01:00:00.000Z" },
        sourceEventAnchor: {
          eventType: SignalEventType.SOUL_SIGNAL_EMITTED,
          eventId: sourceEvent.event_id,
          occurredAt: "2026-07-17T01:00:00.000Z"
        },
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
        temporalProjectionSelected: true,
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
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

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
