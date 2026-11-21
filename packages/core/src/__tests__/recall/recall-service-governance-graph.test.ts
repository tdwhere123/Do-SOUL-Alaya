import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension, type PathRelation } from "@do-soul/alaya-protocol";
import { SqlitePathRelationRepo, readBoundedActiveConstraints } from "@do-soul/alaya-storage";
import { SqliteGovernancePathReader } from "../../../../storage/src/repos/path/reads/governance-path-reader.js";
import { capableRecallConsumerDeclaration, RecallService } from "../../recall/recall-service.js";
import { governanceManifestationCeilings, governanceManifestationFor } from "../../recall/runtime/governance-manifestation.js";
import { assessEvidence } from "../../recall/conditional-field/evidence/assess-support.js";
import { assessmentInput, demand, observation, template } from "./conditional-field/evidence/evidence.fixture.js";
import {
  createPathRelation,
  createRecallDatabaseRegistry,
  createSourceBoundRecallFixture,
  createTaskSurface
} from "./recall-service-test-fixtures.js";
import { MEM, WS, NOW } from "./conditional-field/vertical/source-slice.js";

const registry = createRecallDatabaseRegistry();
afterEach(registry.closeAll);
const CONTENT = "Atlas deployment secret payload ".repeat(12);

async function fixture(paths: readonly PathRelation[] = []) {
  const base = await createSourceBoundRecallFixture(registry.register);
  await base.writeMemory(MEM.r, CONTENT, MemoryDimension.FACT);
  const repo = new SqlitePathRelationRepo(base.database);
  for (const relation of paths) repo.create(relation);
  const reader = new SqliteGovernancePathReader(base.database);
  reader.prepareIndex();
  return { ...base, reader };
}

function path(
  governanceClass: "hint_only" | "attention_only" | "recall_allowed" | "strictly_governed",
  evidenceBasis: string[] = []
) {
  return createPathRelation({ path_id: "governed", sourceId: MEM.l, targetId: MEM.r, governanceClass, evidenceBasis });
}

describe("conditional source governance ceilings", () => {
  it.each([
    ["hint_only", [], "hint"],
    ["attention_only", [], "excerpt"],
    ["recall_allowed", ["recalls_edge_co_usage"], "excerpt"],
    ["recall_allowed", ["signal_graph_reference"], "excerpt"],
    ["strictly_governed", [], "excerpt"]
  ] as const)("keeps %s as a ceiling without restoring strength-based rank tiers", async (band, basis, expected) => {
    const f = await fixture([path(band, [...basis])]);
    const page = f.reader.read({ workspaceId: WS, asOf: NOW, afterPathId: null, limit: 32, byteLimit: 65536 });
    expect(page).toMatchObject({ unavailable: false, truncated: false, temporalUncertain: false });
    expect(page.rows).toHaveLength(1);
    expect(governanceManifestationFor(MEM.r, governanceManifestationCeilings(page.rows), true)).toBe(expected);
  });

  it("never treats byte exhaustion, native exhaustion or a path read failure as ungoverned", async () => {
    const f = await fixture([path("hint_only")]);
    const tiny = f.reader.read({ workspaceId: WS, asOf: NOW, afterPathId: null, limit: 32, byteLimit: 1 });
    expect(tiny.rows).toEqual([]);
    expect(tiny.truncated).toBe(true);
    expect(tiny.bytesRead).toBe(0);
    expect(tiny.rowsRead).toBeLessThanOrEqual(32);
    expect(governanceManifestationFor(MEM.r, new Map(), false)).toBe("hint");
    const bounded = f.reader.read({ workspaceId: WS, asOf: NOW, afterPathId: null, limit: 1, byteLimit: 65536 });
    expect(bounded.rowsRead).toBe(1);
    expect(bounded.truncated).toBe(true);
    f.database.connection.exec("DROP INDEX idx_governance_paths_page");
    expect(f.reader.read({ workspaceId: WS, asOf: NOW, afterPathId: null, limit: 32, byteLimit: 65536 }).unavailable).toBe(true);
  });

  it("keeps target scope and does not turn future mutated rows into historical authority", async () => {
    const f = await fixture([path("hint_only")]);
    expect(f.reader.read({ workspaceId: "other", asOf: NOW, afterPathId: null, limit: 32, byteLimit: 65536 }).rows).toEqual([]);
    f.database.connection.prepare("UPDATE path_relations SET updated_at = ? WHERE path_id = ?")
      .run("2027-01-01T00:00:00.000Z", "governed");
    const old = f.reader.read({ workspaceId: WS, asOf: NOW, afterPathId: null, limit: 32, byteLimit: 65536 });
    expect(old.temporalUncertain).toBe(true);
    expect(old.rows).toEqual([]);
  });

  it("distinguishes a proven empty legacy view from required but unselected temporal authority", async () => {
    const f = await fixture();
    const input = { workspaceId: WS, asOf: NOW, afterPathId: null, limit: 32, byteLimit: 65536 };
    expect(f.reader.read(input)).toMatchObject({ rows: [], truncated: false, unavailable: false });
    f.database.connection.exec("UPDATE temporal_schema_state SET temporal_projection_selection_required = 1 WHERE state_id = 1");
    expect(f.reader.read(input)).toMatchObject({ rows: [], truncated: true, unavailable: true });
    f.database.connection.exec("UPDATE temporal_schema_state SET temporal_projection_selected = 1 WHERE state_id = 1");
    expect(f.reader.read(input).unavailable).toBe(true);
  });

  it.each([false, true])("delivers a hint without a hidden body when governance byte exhaustion is %s", async (exhausted) => {
    const f = await fixture([path("hint_only")]);
    const service = new RecallService({
      ...f.dependencies,
      activeConstraintsPort: {
        findActiveConstraints: async () => { throw new Error("unbounded governance is retired"); },
        readBounded: async (request) => {
          if (request.snapshotId === undefined) throw new Error("governance requires the pinned snapshot");
          return readBoundedActiveConstraints(f.database, { ...request, snapshotId: request.snapshotId }, (input) => {
            const page = f.reader.read({ ...input, ...(exhausted ? { byteLimit: 1 } : {}) });
            if (exhausted) expect(page).toMatchObject({ rows: [], truncated: true });
            return page;
          });
        }
      }
    });
    const result = await service.recall({
      ...capableRecallConsumerDeclaration(),
      taskSurface: { ...createTaskSurface(), display_name: "Atlas deployment" },
      workspaceId: WS,
      strategy: "analyze"
    });
    const candidate = result.candidates.find((row) => row.object_id === MEM.r);
    expect(candidate).toBeDefined();
    expect(candidate?.manifestation).toBe("hint");
    expect(candidate?.content_preview).not.toContain("secret payload");
    expect(candidate?.content_preview).toContain(MEM.r);
  });
});

describe("conditional source governance admission", () => {
  it("applies source-owned tag filters with a positive admitted source", async () => {
    const f = await createSourceBoundRecallFixture(registry.register);
    await f.writeSource({ objectId: MEM.r, content: "Atlas deployment accepted", domainTags: ["allowed"] });
    await f.writeSource({ objectId: MEM.u, content: "Atlas deployment excluded", domainTags: ["other"] });
    const base = f.service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const result = await f.service.recall({
      taskSurface: { ...createTaskSurface(), display_name: "Atlas deployment" },
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: {
        ...base,
        coarse_filter: {
          ...base.coarse_filter,
          deterministic_match: { ...base.coarse_filter.deterministic_match, domain_tag_filter: ["allowed"] }
        }
      }
    });
    expect(result.candidates.map((row) => row.object_id)).toEqual([MEM.r]);
    expect(result.index?.entries.some((row) => row.object_id === MEM.u)).toBe(false);
  });

  it("revokes a tombstoned source without suppressing another admitted source", async () => {
    const f = await createSourceBoundRecallFixture(registry.register);
    await f.writeMemory(MEM.r, "Atlas deployment accepted", MemoryDimension.FACT);
    await f.writeMemory(MEM.u, "Atlas deployment hidden secret", MemoryDimension.FACT);
    f.database.connection.prepare("UPDATE memory_entries SET retention_state = 'tombstoned' WHERE object_id = ?").run(MEM.u);
    const result = await f.service.recall({
      taskSurface: { ...createTaskSurface(), display_name: "Atlas deployment" },
      workspaceId: WS,
      strategy: "analyze"
    });
    expect(result.candidates.map((row) => row.object_id)).toEqual([MEM.r]);
    expect(JSON.stringify(result)).not.toContain("hidden secret");
    expect(result.candidates[0]?.score_factors).toBeUndefined();
  });
});

describe("conditional field path evidence governance", () => {
  it.each([0, 1000])("keeps governed evidence eligibility independent of association %s", (association) => {
    const observations = [
      observation({
        observation_id: "allowed", evidence_id: "allowed", premise_id: "p-allowed",
        proposition_id: "fact", path_governance: "recall_allowed", association_milligrades: association
      }),
      observation({
        observation_id: "strict", evidence_id: "strict", premise_id: "p-strict",
        proposition_id: "fact", path_governance: "strictly_governed", association_milligrades: association
      }),
      observation({
        observation_id: "protected", evidence_id: "protected", premise_id: "p-protected",
        proposition_id: "fact", path_governance: "recall_allowed", access: "protected", association_milligrades: association
      })
    ];
    const result = assessEvidence(assessmentInput({
      observations,
      propositions: [demand("fact", "assertion", [
        template("allowed", ["p-allowed"], 1),
        template("strict", ["p-strict"], 1),
        template("protected", ["p-protected"], 1)
      ])]
    }));
    expect(result.governance.find((row) => row.evidence_id === "allowed")?.admitted).toBe(true);
    expect(result.governance.find((row) => row.evidence_id === "strict")).toMatchObject({
      admitted: false, reason: "strictly_governed"
    });
    expect(result.governance.find((row) => row.evidence_id === "protected")).toMatchObject({
      admitted: false, reason: "protected_source"
    });
    expect(result.records[0]?.claim).toBe("supported");
    expect(result.explanation_ids).toEqual(["allowed/supports"]);
  });
});
