import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RuntimeGovernanceEventType,
  TrustStateEventType,
  type EventLogEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqlitePathRelationRepo,
  SqliteTrustStateRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { EventPublisher } from "@do-soul/alaya-core";
import { createPathPlasticityService } from "../path-plasticity-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("path plasticity daemon wiring", () => {
  it("translates a MEMORY_USAGE_REPORTED event into a measurable PathRelation strength delta via the auditor's plasticity service (integration)", async () => {
    // This test seeds the daemon database with a PathRelation and a
    // delivery+usage receipt, then directly invokes the wired
    // PathPlasticityService (the same service the Garden Auditor's
    // path_plasticity_update task dispatches). It proves the full chain
    //   recordUsage → MEMORY_USAGE_REPORTED in event_log
    //     → UsageProofReader.listRecentUsage returns the record
    //       → PathRelation strength delta + PATH_RELATION_REINFORCED audit row
    // without going through the Garden scheduler timer (which is what the
    // unit test for the Auditor task already covers).
    const dataDir = await createTempDataDir();
    const dbPath = join(dataDir, "alaya.db");
    const database = initDatabase({ filename: dbPath });

    try {
      const eventLogRepo = new SqliteEventLogRepo(database);
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const trustStateRepo = new SqliteTrustStateRepo(database);
      const workspaceRepo = new SqliteWorkspaceRepo(database);

      // Workspace FK target.
      await workspaceRepo.create({
        workspace_id: "workspace-1",
        name: "integration workspace",
        root_path: "/tmp/alaya-integration",
        workspace_kind: WorkspaceKind.LOCAL_REPO,
        default_engine_binding: null,
        workspace_state: WorkspaceState.ACTIVE
      });

      // Minimal EventPublisher (no-op runtime notifier / hot state).
      const eventPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: async () => undefined },
        runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
      });

      // 1. Seed a PathRelation anchored on memory M.
      const pathSeed: PathRelation = {
        path_id: "path-integration-1",
        workspace_id: "workspace-1",
        anchors: {
          source_anchor: { kind: "object", object_id: "memory-source" },
          target_anchor: { kind: "object", object_id: "memory-target" }
        },
        constitution: {
          relation_kind: "supports",
          why_this_relation_exists: ["integration-seed"]
        },
        effect_vector: {
          salience: 0.5,
          recall_bias: 0,
          verification_bias: 0,
          unfinishedness_bias: 0,
          default_manifestation_preference: "stance_bias"
        },
        plasticity_state: {
          strength: 0.4,
          direction_bias: "source_to_target",
          stability_class: "normal",
          support_events_count: 0,
          contradiction_events_count: 0
        },
        lifecycle: { retirement_rule: "default" },
        legitimacy: {
          evidence_basis: ["evidence-integration-1"],
          governance_class: "recall_allowed"
        },
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z"
      };
      await pathRelationRepo.create(pathSeed);

      // 2. Persist a delivery + usage receipt the same way the daemon's
      //    trust-state recorder would. We append the event_log row first
      //    (so audit_event_id is durable), then the trust-state row.
      const deliveryAuditEvent = await eventPublisher.publish({
        event_type: TrustStateEventType.MEMORY_DELIVERED,
        entity_type: "trust_context_delivery",
        entity_id: "delivery-integration-1",
        workspace_id: "workspace-1",
        run_id: null,
        caused_by: "integration-test",
        revision: 1,
        payload_json: {
          delivery_id: "delivery-integration-1",
          agent_target: "integration-test",
          delivered_object_ids: ["memory-target"],
          delivered_at: "2026-05-04T10:00:00.000Z"
        }
      });
      await trustStateRepo.createDelivery({
        delivery_id: "delivery-integration-1",
        agent_target: "integration-test",
        workspace_id: "workspace-1",
        run_id: null,
        delivered_object_ids: ["memory-target"],
        delivered_at: "2026-05-04T10:00:00.000Z",
        audit_event_id: deliveryAuditEvent.event_id
      });

      const usageAuditEvent = await eventPublisher.publish({
        event_type: TrustStateEventType.MEMORY_USAGE_REPORTED,
        entity_type: "trust_usage_proof",
        entity_id: "delivery-integration-1",
        workspace_id: "workspace-1",
        run_id: null,
        caused_by: "integration-test",
        revision: 1,
        payload_json: {
          delivery_id: "delivery-integration-1",
          usage_state: "used",
          used_object_ids: ["memory-target"],
          reason: "integration use",
          reported_at: "2026-05-04T11:00:00.000Z"
        }
      });
      await trustStateRepo.createUsage({
        delivery_id: "delivery-integration-1",
        usage_state: "used",
        used_object_ids: ["memory-target"],
        reason: "integration use",
        reported_at: "2026-05-04T11:00:00.000Z",
        audit_event_id: usageAuditEvent.event_id
      });

      // 3. Build the path plasticity service exactly as the daemon does
      //    in apps/core-daemon/src/index.ts.
      const pathPlasticityService = createPathPlasticityService({
        eventLogRepo,
        trustStateRepo,
        pathRelationRepo,
        eventPublisher,
        now: () => "2026-05-04T12:00:00.000Z"
      });

      // 4. Execute the auditor-equivalent dispatch (sinceIso a few hours
      //    before the receipt's reported_at).
      const result = await pathPlasticityService.computeAndApplyPlasticity({
        workspaceId: "workspace-1",
        sinceIso: "2026-05-04T09:00:00.000Z"
      });

      // 5. Assert the loop closed: one reinforcement, the targeted path
      //    is in the affected list, the durable row strength advanced.
      expect(result.reinforced).toBe(1);
      expect(result.weakened).toBe(0);
      expect(result.retired).toBe(0);
      expect(result.affectedPathIds).toEqual(["path-integration-1"]);

      const updatedPath = await pathRelationRepo.findById("path-integration-1");
      expect(updatedPath).not.toBeNull();
      // Expected strength: 0.4 + reinforcement_increment (0.10 from the
      // DYNAMICS_CONSTANTS.path_plasticity authoritative values).
      expect(updatedPath?.plasticity_state.strength).toBeCloseTo(0.5, 10);
      expect(updatedPath?.plasticity_state.support_events_count).toBe(1);
      expect(updatedPath?.plasticity_state.last_reinforced_at).toBe(
        "2026-05-04T12:00:00.000Z"
      );

      // 6. Audit row exists in event log.
      const reinforcementEvents = await eventLogRepo.queryByEntity(
        "path_relation",
        "path-integration-1"
      );
      const reinforced = reinforcementEvents.filter(
        (event: EventLogEntry) =>
          event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
      );
      expect(reinforced).toHaveLength(1);
      expect(reinforced[0]?.payload_json).toMatchObject({
        path_id: "path-integration-1",
        previous_strength: 0.4,
        new_strength: 0.5,
        support_events_count: 1
      });

      // 7. Sanity: a second tick with sinceIso AFTER the receipt's
      //    reported_at must be a no-op (exclusive watermark per Q4).
      const secondResult = await pathPlasticityService.computeAndApplyPlasticity({
        workspaceId: "workspace-1",
        sinceIso: "2026-05-04T11:00:00.000Z"
      });
      expect(secondResult.reinforced).toBe(0);
      expect(secondResult.affectedPathIds).toEqual([]);
    } finally {
      database.close();
    }
  });
});

async function createTempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "alaya-a3-integration-"));
  tempDirs.push(dir);
  return dir;
}
