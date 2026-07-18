import { describe, expect, it, vi } from "vitest";
import { SignalEventType, type PathRelation } from "@do-soul/alaya-protocol";
import { EventPublisher, RelationAssertionService } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteRelationAssertionRepo,
  SqliteRunRepo,
  SqliteTemporalPathProjectionReader,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import {
  createRecallTemporalProjectionEnsurer,
  createTemporalGraphExplorePathReader,
  createRecallPathReadPorts
} from "../../runtime/recall-path-readers.js";

const workspaceId = "workspace-temporal-reader";
const path = createPathRelation();

describe("createRecallPathReadPorts", () => {
  it("ensures the current projection once while rebuilding exact historical projections", async () => {
    let nowMs = Date.parse("2026-07-17T00:00:00.000Z");
    let activeGeneration = "generation-a";
    let releaseCurrentEnsure: (() => void) | undefined;
    const currentEnsureBlocked = new Promise<void>((resolve) => {
      releaseCurrentEnsure = resolve;
    });
    const verifyAndRebuild = vi.fn(async (asOf?: string) => {
      if (asOf === undefined) {
        await currentEnsureBlocked;
        return {
          projectionGeneration: activeGeneration,
          nextProjectionRefreshAt: "2026-07-17T01:00:00.000Z"
        };
      }
      return { projectionGeneration: "historical-generation", nextProjectionRefreshAt: null };
    });
    const ensureTemporalProjection = createRecallTemporalProjectionEnsurer({
      verifyAndRebuild,
      readActiveProjectionGeneration: () => activeGeneration,
      clock: () => nowMs
    });

    const firstCurrent = ensureTemporalProjection();
    const concurrentCurrent = ensureTemporalProjection({});
    releaseCurrentEnsure?.();
    await Promise.all([firstCurrent, concurrentCurrent]);
    await ensureTemporalProjection();
    await ensureTemporalProjection({ asOf: "2026-07-17T00:00:00.000Z" });
    await ensureTemporalProjection({ asOf: "2026-07-17T00:00:00.000Z" });
    nowMs = Date.parse("2026-07-17T01:00:00.000Z");
    activeGeneration = "generation-a";
    await ensureTemporalProjection();

    expect(verifyAndRebuild.mock.calls).toEqual([
      [],
      ["2026-07-17T00:00:00.000Z"],
      ["2026-07-17T00:00:00.000Z"],
      []
    ]);
  });

  it("keeps the legacy reader as the default mode", async () => {
    const legacy = {
      findByAnchors: vi.fn(async () => [path]),
      findByWorkspaceAll: vi.fn(async () => [path]),
      findActiveAll: vi.fn(async () => [path])
    };

    const ports = createRecallPathReadPorts({ legacyPathReader: legacy });

    await expect(ports.pathExpansionPort.findByAnchors(workspaceId, [
      { kind: "object", object_id: "memory-a" }
    ])).resolves.toEqual([path]);
    await expect(ports.pathExpansionPort.findByTimeConcernWindowDigests(
      workspaceId,
      ["next week"]
    )).resolves.toEqual([path]);

    expect(legacy.findByAnchors).toHaveBeenCalledOnce();
    expect(legacy.findByWorkspaceAll).toHaveBeenCalledWith(workspaceId);
  });

  it("uses only temporal projections for selected expansion, time concerns, and plasticity", async () => {
    const legacy = {
      findByAnchors: vi.fn(async () => {
        throw new Error("legacy reader must not be called after selection");
      }),
      findByWorkspaceAll: vi.fn(async () => {
        throw new Error("legacy reader must not be called after selection");
      }),
      findActiveAll: vi.fn(async () => {
        throw new Error("legacy reader must not be called after selection");
      })
    };
    const temporal = {
      findByAnchors: vi.fn(async () => [path]),
      findByTimeConcernWindowDigests: vi.fn(async () => [path]),
      findByWorkspace: vi.fn(async () => [path])
    };
    const ensureTemporalProjection = vi.fn(async () => undefined);
    const ports = createRecallPathReadPorts({
      temporalProjectionSelected: true,
      legacyPathReader: legacy,
      temporalPathProjectionReader: temporal,
      ensureTemporalProjection
    });
    const options = { asOf: "2026-07-17T00:00:00.000Z" };

    await expect(ports.pathExpansionPort.findByAnchors(
      workspaceId,
      [{ kind: "object", object_id: "memory-a" }],
      options
    )).resolves.toEqual([path]);
    await expect(ports.pathExpansionPort.findByTimeConcernWindowDigests(
      workspaceId,
      ["next week"],
      options
    )).resolves.toEqual([path]);
    await expect(ports.pathPlasticityPort.getStrengthByMemoryId(
      workspaceId,
      ["memory-a"],
      options
    )).resolves.toEqual(new Map([["memory-a", 0.8]]));
    await expect(ports.findActiveByWorkspace(workspaceId, options)).resolves.toEqual([path]);

    expect(temporal.findByAnchors).toHaveBeenLastCalledWith(
      workspaceId,
      [{ kind: "object", object_id: "memory-a" }],
      options
    );
    expect(temporal.findByTimeConcernWindowDigests).toHaveBeenCalledWith(
      workspaceId,
      ["next_week"],
      options
    );
    expect(temporal.findByWorkspace).toHaveBeenCalledWith(workspaceId, options);
    expect(ensureTemporalProjection).toHaveBeenCalledTimes(4);
    expect(ensureTemporalProjection).toHaveBeenLastCalledWith(options);
    expect(legacy.findByAnchors).not.toHaveBeenCalled();
    expect(legacy.findByWorkspaceAll).not.toHaveBeenCalled();
  });

  it("fails closed when selected mode has no temporal projection reader", () => {
    expect(() => createRecallPathReadPorts({ temporalProjectionSelected: true })).toThrow(
      "selected temporal projection requires a temporal path reader"
    );
  });

  it("fails closed when selected mode cannot ensure its assertion projection", () => {
    expect(() => createRecallPathReadPorts({
      temporalProjectionSelected: true,
      temporalPathProjectionReader: {
        findByAnchors: async () => [],
        findByTimeConcernWindowDigests: async () => [],
        findByWorkspace: async () => []
      }
    })).toThrow("selected temporal projection requires an assertion projection ensurer");
  });

  it("derives graph lookups from the temporal projection without a legacy reader", async () => {
    const sourceOnlyPath = createPathRelation({
      path_id: "path-source-only",
      anchors: {
        source_anchor: path.anchors.target_anchor,
        target_anchor: { kind: "object", object_id: "memory-c" }
      }
    });
    const temporal = {
      findByAnchors: vi.fn(async () => [path, sourceOnlyPath]),
      findByTimeConcernWindowDigests: vi.fn(async () => [path]),
      findByWorkspace: vi.fn(async () => [path])
    };
    const options = { asOf: "2026-07-16T00:00:00.000Z" };
    const ensureTemporalProjection = vi.fn(async () => undefined);
    const graphReader = createTemporalGraphExplorePathReader(
      temporal,
      ensureTemporalProjection,
      options
    );

    await expect(graphReader.findByTargetAnchor(workspaceId, {
      kind: "time_concern",
      source_object_id: "memory-a",
      window_digest: "next_week"
    })).resolves.toEqual([path]);
    await expect(graphReader.findByBackingObjectIds!(workspaceId, ["memory-a"])).resolves.toEqual([path]);
    await expect(graphReader.findByBackingObjectId(workspaceId, "memory-b")).resolves.toEqual([]);

    expect(temporal.findByAnchors).toHaveBeenCalledWith(
      workspaceId,
      [path.anchors.target_anchor],
      options
    );
    expect(temporal.findByWorkspace).toHaveBeenCalledTimes(2);
    expect(temporal.findByWorkspace).toHaveBeenLastCalledWith(workspaceId, options);
    expect(ensureTemporalProjection).toHaveBeenCalledTimes(3);
  });

  it("rebuilds current and exact historical selected projections in the direct fallback", async () => {
    const database = initDatabase({ filename: ":memory:" });
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
    const relationAssertionRepo = new SqliteRelationAssertionRepo(database);
    let currentAsOf = "2026-07-17T02:00:00.000Z";
    const relationAssertionService = new RelationAssertionService({
      repo: relationAssertionRepo,
      eventPublisher: new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: () => undefined },
        runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
      }),
      eventHistory: eventLogRepo,
      now: () => currentAsOf
    });
    const historicalAsOf = "2026-07-17T01:30:00.000Z";
    try {
      workspaceRepo.create({
        workspace_id: workspaceId,
        name: "Temporal fallback test",
        root_path: "/tmp/temporal-fallback-test",
        workspace_kind: "local_repo",
        repo_path: "/tmp/temporal-fallback-test",
        default_engine_binding: null,
        workspace_state: "active"
      });
      await new SqliteRunRepo(database).create({
        run_id: "run-temporal-direct",
        workspace_id: workspaceId,
        title: "Temporal direct projection test",
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
        entity_id: "signal-temporal-direct",
        workspace_id: workspaceId,
        run_id: "run-temporal-direct",
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
        run_id: "run-temporal-direct",
        workspace_id: workspaceId,
        surface_id: null
      });
      await relationAssertionService.admit({
        assertionId: "assertion-selected-direct",
        workspaceId,
        runId: "run-temporal-direct",
        causedBy: "garden",
        evidenceIds: ["85b3671a-d8d8-4848-9e5c-07d0a89f5ae9"],
        anchors: {
          source_anchor: { kind: "object", object_id: "memory-a" },
          target_anchor: { kind: "object", object_id: "memory-b" }
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
        assertionId: "assertion-selected-direct",
        workspaceId,
        runId: "run-temporal-direct",
        causedBy: "garden",
        resolutionKind: "retracted",
        reason: "historical test resolution",
        resolvedAt: "2026-07-17T01:45:00.000Z"
      });
      const temporalReader = new SqliteTemporalPathProjectionReader(relationAssertionRepo);
      const verifyAndRebuild = vi.spyOn(relationAssertionService, "verifyAndRebuild");

      const ports = createRecallPathReadPorts({
        temporalProjectionSelected: true,
        temporalPathProjectionReader: temporalReader,
        ensureTemporalProjection: createRecallTemporalProjectionEnsurer(relationAssertionService)
      });

      await expect(temporalReader.findByAnchors(workspaceId, [
        { kind: "object", object_id: "memory-a" }
      ], { asOf: historicalAsOf })).rejects.toThrow(/No verified temporal projection/);
      await expect(ports.pathExpansionPort.findByAnchors(workspaceId, [
        { kind: "object", object_id: "memory-a" }
      ])).resolves.toEqual([]);
      await expect(ports.pathExpansionPort.findByAnchors(workspaceId, [
        { kind: "object", object_id: "memory-a" }
      ], { asOf: historicalAsOf })).resolves.toMatchObject([
        { path_id: "assertion-selected-direct" }
      ]);
      await expect(ports.findActiveByWorkspace(workspaceId)).resolves.toEqual([]);
      await relationAssertionService.admit({
        assertionId: "assertion-selected-bounded",
        workspaceId,
        runId: "run-temporal-direct",
        causedBy: "garden",
        evidenceIds: ["85b3671a-d8d8-4848-9e5c-07d0a89f5ae9"],
        anchors: path.anchors,
        relationKind: "time_concern",
        validity: {
          kind: "bounded",
          valid_from: "2026-07-17T02:00:00.000Z",
          valid_to: "2026-07-17T03:00:00.000Z"
        },
        sourceEventAnchor: {
          eventType: SignalEventType.SOUL_SIGNAL_EMITTED,
          eventId: sourceEvent.event_id,
          occurredAt: "2026-07-17T01:00:00.000Z"
        },
        admittedAt: "2026-07-17T02:00:00.000Z"
      });
      await expect(ports.findActiveByWorkspace(workspaceId)).resolves.toMatchObject([
        { path_id: "assertion-selected-bounded" }
      ]);
      currentAsOf = "2026-07-17T03:00:00.000Z";
      await expect(ports.findActiveByWorkspace(workspaceId)).resolves.toEqual([]);
      expect(verifyAndRebuild.mock.calls).toEqual([
        [],
        [historicalAsOf],
        [],
        []
      ]);
    } finally {
      database.close();
    }
  });
});

function createPathRelation(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-temporal-reader",
    workspace_id: workspaceId,
    anchors: {
      source_anchor: { kind: "object", object_id: "memory-a" },
      target_anchor: { kind: "time_concern", source_object_id: "memory-a", window_digest: "next_week" }
    },
    constitution: {
      relation_kind: "co_usage",
      why_this_relation_exists: ["test"]
    },
    effect_vector: {
      salience: 0.8,
      recall_bias: 0.8,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.8,
      direction_bias: "target_to_source",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0,
      last_reinforced_at: "2026-07-17T00:00:00.000Z"
    },
    lifecycle: {
      status: "active",
      retirement_rule: "janitor_ttl_low_strength"
    },
    ...overrides,
    legitimacy: {
      evidence_basis: ["evidence-test"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z"
  };
}
