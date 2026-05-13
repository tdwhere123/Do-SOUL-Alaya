import { describe, expect, it, vi } from "vitest";
import type { BootstrappingPathTemplate } from "@do-soul/alaya-protocol";
import {
  EventPublisher,
  RunHotStateService,
  WorkspaceService
} from "@do-soul/alaya-core";
import { BootstrappingService } from "@do-soul/alaya-soul";
import {
  initDatabase,
  SqliteBootstrappingRecordRepo,
  SqliteEventLogRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { defaultBootstrappingTemplates } from "../daemon-defaults.js";

const noopRuntimeNotifier = {
  notify: vi.fn<(runId: string, event: unknown) => void>(),
  notifyEntry: vi.fn<(entry: unknown) => void>()
};

describe("workspace bootstrap reconcile (real sqlite)", () => {
  it("does not invent PathRelation seeds when daemon defaults provide no templates", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const workspaceId = "ws_reconcile_alpha";
      seedWorkspace(database, workspaceId);

      const workspaceRepo = new SqliteWorkspaceRepo(database);
      const runRepo = new SqliteRunRepo(database);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const bootstrappingRecordRepo = new SqliteBootstrappingRecordRepo(database);
      const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
      const eventPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService,
        runtimeNotifier: noopRuntimeNotifier
      });
      const bootstrappingPlanner = new BootstrappingService({
        templates: defaultBootstrappingTemplates,
        now: () => "2026-05-13T00:00:00.000Z"
      });

      const service = new WorkspaceService({
        workspaceRepo,
        runRepo,
        eventPublisher,
        bootstrappingPlanner,
        pathRelationRepo,
        bootstrappingRecordRepo
      });

      expect(await pathRelationRepo.findByWorkspace(workspaceId)).toEqual([]);
      expect(bootstrappingRecordRepo.findByWorkspace(workspaceId)).toBeNull();

      const first = await service.reconcileBootstrapPaths(workspaceId);
      expect(first).toEqual({
        status: "skipped_no_templates",
        workspace_id: workspaceId,
        template_ids: []
      });
      expect(await pathRelationRepo.findByWorkspace(workspaceId)).toEqual([]);
      expect(bootstrappingRecordRepo.findByWorkspace(workspaceId)).toBeNull();
      expect(countBootstrappingPlantedEvents(database)).toBe(0);
    } finally {
      database.close();
    }
  });

  it("plants explicitly configured seed paths on an empty workspace and is a no-op on the second pass", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const workspaceId = "ws_reconcile_explicit";
      seedWorkspace(database, workspaceId);
      const explicitTemplates = createExplicitBootstrappingTemplates();

      const workspaceRepo = new SqliteWorkspaceRepo(database);
      const runRepo = new SqliteRunRepo(database);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const bootstrappingRecordRepo = new SqliteBootstrappingRecordRepo(database);
      const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
      const eventPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService,
        runtimeNotifier: noopRuntimeNotifier
      });
      const bootstrappingPlanner = new BootstrappingService({
        templates: explicitTemplates,
        now: () => "2026-05-13T00:00:00.000Z"
      });

      const service = new WorkspaceService({
        workspaceRepo,
        runRepo,
        eventPublisher,
        bootstrappingPlanner,
        pathRelationRepo,
        bootstrappingRecordRepo
      });

      const first = await service.reconcileBootstrapPaths(workspaceId);
      expect(first).toMatchObject({
        status: "planted",
        workspace_id: workspaceId,
        paths_planted: explicitTemplates.length,
        template_ids: explicitTemplates.map((t) => t.template_id)
      });

      const persistedRelations = await pathRelationRepo.findByWorkspace(workspaceId);
      expect(persistedRelations.length).toBe(explicitTemplates.length);
      const persistedRecord = bootstrappingRecordRepo.findByWorkspace(workspaceId);
      expect(persistedRecord).not.toBeNull();
      expect(persistedRecord?.paths_planted).toBe(explicitTemplates.length);

      const eventCountAfterFirst = countBootstrappingPlantedEvents(database);
      expect(eventCountAfterFirst).toBe(1);

      const second = await service.reconcileBootstrapPaths(workspaceId);
      expect(second).toMatchObject({
        status: "already_planted",
        workspace_id: workspaceId,
        record_id: persistedRecord?.record_id ?? null
      });
      expect((await pathRelationRepo.findByWorkspace(workspaceId)).length).toBe(
        persistedRelations.length
      );
      expect(countBootstrappingPlantedEvents(database)).toBe(eventCountAfterFirst);
    } finally {
      database.close();
    }
  });

  it("returns skipped_no_planner when WorkspaceService is wired without bootstrapping deps", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const workspaceId = "ws_no_planner";
      seedWorkspace(database, workspaceId);

      const workspaceRepo = new SqliteWorkspaceRepo(database);
      const runRepo = new SqliteRunRepo(database);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
      const eventPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService,
        runtimeNotifier: noopRuntimeNotifier
      });

      const service = new WorkspaceService({
        workspaceRepo,
        runRepo,
        eventPublisher
      });

      const result = await service.reconcileBootstrapPaths(workspaceId);
      expect(result).toEqual({
        status: "skipped_no_planner",
        workspace_id: workspaceId
      });
    } finally {
      database.close();
    }
  });
});

function createExplicitBootstrappingTemplates(): readonly BootstrappingPathTemplate[] {
  return [
    {
      template_id: "workspace.bootstrap.explicit-test",
      relation_kind: "supports",
      why_this_relation_exists: ["test-configured ontology seed"],
      source_anchor_template: {
        kind: "object",
        description: "workspace"
      },
      target_anchor_template: {
        kind: "object_facet",
        description: "explicit_test_seed"
      },
      default_strength: 0.1,
      default_stability_class: "volatile",
      default_governance_class: "hint_only",
      default_manifestation_preference: "stance_bias"
    }
  ];
}

function seedWorkspace(database: ReturnType<typeof initDatabase>, workspaceId: string): void {
  database.connection
    .prepare(
      `INSERT INTO workspaces (
        workspace_id,
        name,
        root_path,
        workspace_kind,
        default_engine_binding,
        workspace_state,
        created_at,
        archived_at,
        default_engine_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      workspaceId,
      "Reconcile Test",
      "/tmp/reconcile",
      "local_repo",
      null,
      "active",
      "2026-05-13T00:00:00.000Z",
      null,
      null
    );
}

function countBootstrappingPlantedEvents(
  database: ReturnType<typeof initDatabase>
): number {
  const row = database.connection
    .prepare(
      `SELECT COUNT(*) AS count FROM event_log WHERE event_type = 'bootstrapping.paths_planted'`
    )
    .get() as { readonly count: number };
  return row.count;
}
