import { afterEach, describe, expect, it } from "vitest";
import type { OpenSemanticFactorGraph } from "@do-soul/alaya-protocol";
import { readObjectKeyEvidenceSources } from "../../../repos/capsules/object-key-source-reader.js";
import {
  createEvidenceCapsule,
  createEvidenceCapsuleRepo,
  evidenceCapsuleDatabases as databases
} from "./evidence-capsule-repo-fixture.js";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("readObjectKeyEvidenceSources", () => {
  it("loads gist, fact-key contents, and a formed OSF graph for minting", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = createEvidenceCapsule({
      object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      gist: "She loves her Golden Retriever."
    });
    await repo.create(capsule);
    database.connection.prepare(`
      INSERT INTO evidence_search_projections (
        evidence_object_id, projection_id, projection_kind,
        workspace_id, source_hash, content
      ) VALUES (?, 1, 'fact_key', ?, 'hash-1', ?)
    `).run(capsule.object_id, capsule.workspace_id, "I took my niece to the museum");
    database.connection.prepare(`
      INSERT INTO evidence_semantic_factor_formations (
        evidence_object_id, workspace_id, schema_version, operator_id, status,
        producer_operator_id, source_sha256, graph_json, capture_digest
      ) VALUES (?, ?, 1, 'open_semantic_factor_formation_v1', 'formed',
        'producer-v1', ?, ?, ?)
    `).run(
      capsule.object_id,
      capsule.workspace_id,
      `sha256:${"b".repeat(64)}`,
      JSON.stringify(osfGraph()),
      `sha256:${"a".repeat(64)}`
    );

    expect(readObjectKeyEvidenceSources(
      database,
      capsule.workspace_id,
      [capsule.object_id, "missing-evidence"]
    )).toEqual([{
      object_id: capsule.object_id,
      gist: "She loves her Golden Retriever.",
      fact_key_contents: ["I took my niece to the museum"],
      osf_graph: osfGraph()
    }]);
  });
});

function osfGraph(): OpenSemanticFactorGraph {
  return {
    schema_version: 1,
    source_kind: "evidence",
    factors: [
      {
        factor_id: "predicate",
        surface: "bought",
        source_span: [2, 8],
        semantic_identity: "buy"
      },
      {
        factor_id: "period",
        surface: "July",
        source_span: [29, 33],
        semantic_identity: "july"
      }
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "purchase-event",
      predicate_factor_id: "predicate",
      arguments: [
        {
          position: 0,
          binding_identity: "buy",
          reference_kind: "factor",
          reference_id: "predicate"
        },
        {
          position: 1,
          binding_identity: "july",
          reference_kind: "factor",
          reference_id: "period"
        }
      ]
    }]
  };
}
