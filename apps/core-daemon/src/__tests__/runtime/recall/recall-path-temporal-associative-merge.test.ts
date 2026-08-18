import { describe, expect, it } from "vitest";
import { isPathActiveForRecall, type PathRelation } from "@do-soul/alaya-protocol";
import { EventPublisher, fieldContractSha256, RelationAssertionService } from "@do-soul/alaya-core";
import { LEGACY_STRUCTURED_EMPTY_HISTORY_DIGEST } from
  "../../../../../../packages/core/src/path-graph/relation-assertions/legacy-empty-history-digest.js";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteFieldCausalUsageRepo,
  SqliteRelationAssertionRepo,
  SqliteSoftAssociationPathRepo,
  SqliteTemporalPathProjectionReader,
  SqliteWorkspaceRepo,
  TemporalProjectionGenerationMissingError,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createCausalUsageTemporalPathReader } from
  "../../../runtime/recall/causal-usage-temporal-path-reader.js";
import { createBoundRecallPathReadPorts } from "../../../runtime/recall/recall-path-read-bind.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import {
  createRecallPathReadPorts,
  createRecallTemporalProjectionEnsurer
} from "../../../runtime/recall/recall-path-readers.js";

const AS_OF = "2026-07-17T01:30:00.000Z";
const WORKSPACE_ID = "workspace-temporal";
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const ANCHORS = [{ kind: "object" as const, object_id: SOURCE_ID }];

describe("temporal/associative merge authority", () => {
  it("query-only as-of reads fail closed without a verified generation", async () => {
    const database = openMergeDatabase();
    try {
      const association = plantEligibleAssociative(database);
      assertEligibleAssociativeFixture(association, AS_OF);
      expect(countRelationAssertions(database)).toBe(0);

      await expect(createBoundRecallPathReadPorts({ database }).pathExpansionPort.findByAnchors(
        WORKSPACE_ID,
        ANCHORS,
        { asOf: AS_OF }
      )).rejects.toBeInstanceOf(TemporalProjectionGenerationMissingError);
    } finally {
      database.close();
    }
  });

  it("parent-prepared as-of reads merge one eligible association over empty temporal", async () => {
    const database = openMergeDatabase();
    try {
      const association = plantEligibleAssociative(database);
      assertEligibleAssociativeFixture(association, AS_OF);
      expect(countRelationAssertions(database)).toBe(0);
      const parent = createParentPathReadPorts(database);

      await parent.ports.ensureTemporalProjection({ asOf: AS_OF });
      await expect(parent.temporalReader.findByAnchors(WORKSPACE_ID, ANCHORS, { asOf: AS_OF }))
        .resolves.toEqual([]);
      await expect(parent.ports.pathExpansionPort.findByAnchors(WORKSPACE_ID, ANCHORS, {
        asOf: AS_OF
      })).resolves.toEqual([association]);
    } finally {
      database.close();
    }
  });

  it("parent-prepared merge from a legacy-operator DB still returns the eligible association", async () => {
    const database = openMergeDatabase();
    try {
      const association = plantEligibleAssociative(database);
      retargetLiveOperatorToLegacyStructuredEmpty(database);
      const parent = createParentPathReadPorts(database);

      await parent.ports.ensureTemporalProjection({ asOf: AS_OF });
      await expect(parent.temporalReader.findByAnchors(WORKSPACE_ID, ANCHORS, { asOf: AS_OF }))
        .resolves.toEqual([]);
      await expect(parent.ports.pathExpansionPort.findByAnchors(WORKSPACE_ID, ANCHORS, {
        asOf: AS_OF
      })).resolves.toEqual([association]);
    } finally {
      database.close();
    }
  });

  it("excludes an ineligible associative row from parent-prepared merge", async () => {
    const database = openMergeDatabase();
    try {
      const eligible = plantEligibleAssociative(database);
      const ineligible = plantIneligibleAssociative(database);
      const parent = createParentPathReadPorts(database);
      const associative = new SqliteSoftAssociationPathRepo(database);

      await expect(associative.findByAnchors(WORKSPACE_ID, ANCHORS))
        .resolves.toEqual(expect.arrayContaining([eligible, ineligible]));
      await expect(associative.findByAnchors(WORKSPACE_ID, ANCHORS, { asOf: AS_OF }))
        .resolves.toEqual([eligible]);
      await parent.ports.ensureTemporalProjection({ asOf: AS_OF });
      await expect(parent.ports.pathExpansionPort.findByAnchors(WORKSPACE_ID, ANCHORS, {
        asOf: AS_OF
      })).resolves.toEqual([eligible]);
    } finally {
      database.close();
    }
  });

  it("selected-temporal worker construction rejects a spawn-invalid URL before Worker spawn", () => {
    expect(() => createRecallReadWorkerClient({
      databaseFilename: "/unused-alaya-recall-read.db",
      pathReadBind: "temporal",
      workerUrl: new URL("https://example.invalid/would-spawn-fail-selected-temporal-worker.js")
    })).toThrow("selected temporal recall worker requires parent projection preparation");
  });
});

function openMergeDatabase(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  new SqliteWorkspaceRepo(database).create({
    workspace_id: WORKSPACE_ID,
    name: "Temporal associative merge",
    root_path: "/tmp/temporal-associative-merge",
    workspace_kind: "local_repo",
    repo_path: "/tmp/temporal-associative-merge",
    default_engine_binding: null,
    workspace_state: "active"
  });
  return database;
}

function createParentPathReadPorts(database: StorageDatabase) {
  const relationAssertionRepo = new SqliteRelationAssertionRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const relationAssertionService = new RelationAssertionService({
    repo: relationAssertionRepo,
    eventPublisher: new EventPublisher({
      eventLogRepo,
      runHotStateService: { apply: () => undefined },
      runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
    }),
    eventHistory: eventLogRepo
  });
  const temporalReader = new SqliteTemporalPathProjectionReader(relationAssertionRepo);
  return {
    temporalReader,
    ports: createRecallPathReadPorts({
      temporalProjectionSelected: true,
      temporalPathProjectionReader: createCausalUsageTemporalPathReader({
        base: temporalReader,
        usageRepo: new SqliteFieldCausalUsageRepo(database, fieldContractSha256)
      }),
      softAssociationPathReader: new SqliteSoftAssociationPathRepo(database),
      ensureTemporalProjection: createRecallTemporalProjectionEnsurer(relationAssertionService)
    })
  };
}

function plantEligibleAssociative(database: StorageDatabase): PathRelation {
  return new SqliteSoftAssociationPathRepo(database).create(createEligibleAssociativeRelation());
}

function plantIneligibleAssociative(database: StorageDatabase): PathRelation {
  return new SqliteSoftAssociationPathRepo(database).create({
    ...createEligibleAssociativeRelation(),
    path_id: "soft-association-merge-ineligible",
    created_at: "2026-07-18T00:00:00.000Z",
    updated_at: "2026-07-18T00:00:00.000Z"
  });
}

function countRelationAssertions(database: StorageDatabase): number {
  const row = database.connection.prepare(
    "SELECT COUNT(*) AS n FROM relation_assertions"
  ).get() as { readonly n: number };
  return row.n;
}

function retargetLiveOperatorToLegacyStructuredEmpty(database: StorageDatabase): string {
  const digest = LEGACY_STRUCTURED_EMPTY_HISTORY_DIGEST;
  database.connection.prepare(`
    UPDATE temporal_schema_state
    SET history_digest = ?
    WHERE state_id = 1
  `).run(digest);
  database.connection.prepare(`
    UPDATE temporal_projection_generations
    SET history_digest = ?
    WHERE generation = (
      SELECT active_projection_generation FROM temporal_schema_state WHERE state_id = 1
    )
  `).run(digest);
  return digest;
}

function assertEligibleAssociativeFixture(path: PathRelation, asOf: string): void {
  const asOfMs = Date.parse(asOf);
  expect(path.constitution.relation_kind).toBe("co_recalled");
  expect(path.anchors.source_anchor.kind).toBe("object");
  expect(path.anchors.target_anchor.kind).toBe("object");
  expect(path.effect_vector.recall_bias).toBeGreaterThan(0);
  expect(isPathActiveForRecall(path.lifecycle.status)).toBe(true);
  expect(path.legitimacy.governance_class).toBe("attention_only");
  expect(path.legitimacy.evidence_basis).toEqual(["recalls_edge_co_usage"]);
  expect(Date.parse(path.created_at)).toBeLessThanOrEqual(asOfMs);
  expect(Date.parse(path.updated_at)).toBeLessThanOrEqual(asOfMs);
}

function createEligibleAssociativeRelation(): PathRelation {
  return {
    path_id: "soft-association-merge-eligible",
    workspace_id: WORKSPACE_ID,
    anchors: {
      source_anchor: { kind: "object", object_id: SOURCE_ID },
      target_anchor: { kind: "object", object_id: TARGET_ID }
    },
    constitution: {
      relation_kind: "co_recalled",
      why_this_relation_exists: ["earned co-recall"]
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
      evidence_basis: ["recalls_edge_co_usage"],
      governance_class: "attention_only"
    },
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z"
  };
}
