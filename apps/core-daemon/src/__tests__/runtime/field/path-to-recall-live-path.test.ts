import { describe, expect, it } from "vitest";
import { SqliteSoftAssociationPathRepo } from "@do-soul/alaya-storage";
import {
  CLOCK,
  WORKSPACE_ID,
  composeField,
  createPlantedHarness,
  createPlantedRecall,
  memoryEntry,
  persistMemory,
  realMemoryRepo,
  recallRequest,
  seedRun
} from "./p217-planted-harness.js";

const planted = createPlantedHarness();
const SEED_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const LINKED_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const PATH_ID = "22222222-2222-4222-8222-aaaaaaaaaaaa";
const QUERY = "Ada";

describe("path to recall live path", () => {
  it("introduces the linked memory only through path_expansion", async () => {
    const runtime = await openPathRecall();
    const lexical = await runtime.memoryRepo.searchByKeyword(WORKSPACE_ID, QUERY, 10);
    const result = await runtime.recall.recall(recallRequest(QUERY));
    const linked = result.candidates.find((candidate) => candidate.object_id === LINKED_ID);
    const diagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === LINKED_ID
    );

    expect(lexical.map((hit) => hit.object_id)).toEqual([SEED_ID]);
    expect(linked).toBeDefined();
    expect(linked?.source_channels).toContain("path_expansion");
    expect(diagnostic?.admission_planes).toEqual(["path_expansion"]);
    expect(diagnostic?.plane_first_admitted).toBe("path_expansion");
    expect(diagnostic?.plane_winning_admission).toBe("path_expansion");
    expect(result.candidates.map((candidate) => candidate.object_id)).toContain(LINKED_ID);
  });
});

async function openPathRecall() {
  const database = planted.openMemoryDatabase();
  const field = composeField(database);
  field.projectionLifecycle.rebuild(WORKSPACE_ID, CLOCK);
  seedRun(database, "run-2");
  await persistMemory(database, memoryEntry({
    object_id: SEED_ID,
    content: "Ada wrote the command notes.",
    evidence_refs: []
  }));
  await persistMemory(database, memoryEntry({
    object_id: LINKED_ID,
    content: "Distinct sealed binder.",
    evidence_refs: [],
    run_id: "run-2"
  }));
  const pathRepo = persistPathRelation(database);
  const memoryRepo = realMemoryRepo(database);
  return {
    memoryRepo,
    recall: createPlantedRecall({
      database,
      field,
      memoryRepo,
      extra: {
        pathExpansionPort: {
          findByAnchors: pathRepo.findByAnchors.bind(pathRepo)
        }
      }
    })
  };
}

function persistPathRelation(
  database: Parameters<typeof persistMemory>[0]
): SqliteSoftAssociationPathRepo {
  const repo = new SqliteSoftAssociationPathRepo(database);
  repo.create({
    path_id: PATH_ID,
    workspace_id: WORKSPACE_ID,
    anchors: {
      source_anchor: { kind: "object", object_id: SEED_ID },
      target_anchor: { kind: "object", object_id: LINKED_ID }
    },
    constitution: {
      relation_kind: "co_recalled",
      why_this_relation_exists: ["seed to linked object edge"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.3,
      direction_bias: "source_to_target",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0,
      last_reinforced_at: CLOCK
    },
    lifecycle: {
      status: "active",
      retirement_rule: "janitor_ttl_low_strength"
    },
    legitimacy: {
      evidence_basis: ["recalls_edge_co_usage"],
      governance_class: "attention_only"
    },
    created_at: CLOCK,
    updated_at: CLOCK
  });
  return repo;
}
