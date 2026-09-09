import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { prepareIndexedRecallProjection, SqliteIndexedRecallProjection } from "../../../repos/garden/indexed-recall-projection.js";

const databases: StorageDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = initDatabase({ filename: ":memory:" });
  databases.push(database);
  prepareIndexedRecallProjection(database);
  database.connection.exec(`
    INSERT INTO workspaces(workspace_id,name,root_path,workspace_kind,created_at)
      VALUES ('workspace','workspace','/tmp/workspace','local_repo','2026-09-06T00:00:00.000Z');
    INSERT INTO garden_projection_cursor(workspace_id,applied_event_revision,applied_at,observable_epoch,observable_generation)
      VALUES ('workspace',0,'2026-09-06T00:00:00.000Z','epoch',0);
    INSERT INTO garden_projection_cursor(workspace_id,applied_event_revision,applied_at,observable_epoch,observable_generation)
      VALUES ('other',0,'2026-09-06T00:00:00.000Z','other-epoch',0);
    INSERT INTO relation_assertions(assertion_id,workspace_id,admission_event_id,identity_key,anchors_json,relation_kind,validity_json,admitted_at)
      VALUES ('assertion','workspace','event','identity','{}','governance','{}','2026-09-06T00:00:00.000Z');
  `);
  return { database, projection: new SqliteIndexedRecallProjection(database.connection) };
}

const ROWS = [
  {
    table: "path_relations",
    insert: `INSERT INTO path_relations(path_id,workspace_id,anchors_json,constitution_json,effect_vector_json,
      plasticity_state_json,lifecycle_json,legitimacy_json,created_at,updated_at)
      VALUES ('path','workspace','{}','{}','{}','{}','{}','{}','2026-09-06T00:00:00.000Z','2026-09-06T00:00:00.000Z')`,
    mutation: "constitution_json = '{\"ceiling\":0}'"
  },
  {
    table: "claim_forms",
    insert: `INSERT INTO claim_forms(object_id,created_at,updated_at,created_by,governance_subject,claim_kind,
      scope_class,enforcement_level,origin_tier,precedence_basis,proposition_digest,workspace_id)
      VALUES ('claim','2026-09-06T00:00:00.000Z','2026-09-06T00:00:00.000Z','user_action','{}',
      'constraint','project','hard','user','explicit','digest','workspace')`,
    mutation: "claim_status = 'active'"
  },
  {
    table: "relation_path_projections",
    insert: `INSERT INTO relation_path_projections(generation,path_id,assertion_id,workspace_id,projection_json)
      SELECT active_projection_generation,'projection','assertion','workspace','{}' FROM temporal_schema_state WHERE state_id=1`,
    mutation: "projection_json = '{\"ceiling\":0}'"
  },
  {
    table: "source_records",
    insert: `INSERT INTO source_records(record_id,workspace_id,source_id,source_version,content_digest,
      evidence_object_id,recorded_at,event_time,valid_from,valid_to,operator_id,source_body)
      VALUES ('record','workspace','src','v1','sha256:aaa',NULL,'2026-09-06T00:00:00.000Z',NULL,NULL,NULL,'op','body')`,
    mutation: "source_body = 'mutated'"
  },
  {
    table: "evidence_capsules",
    insert: `INSERT INTO evidence_capsules(object_id,object_kind,schema_version,lifecycle_state,created_at,updated_at,
      created_by,evidence_kind,semantic_anchor,event_anchor,physical_anchor,evidence_health_state,gist,excerpt,
      source_hash,run_id,workspace_id,surface_id)
      VALUES ('11111111-1111-4111-8111-111111111111','evidence_capsule',1,'active','2026-09-06T00:00:00.000Z',
      '2026-09-06T00:00:00.000Z','user_action','conversation_excerpt',
      '{"topic":"pin","keywords":["pin"],"summary":"gist"}',NULL,NULL,'verified','gist',NULL,NULL,'run','workspace',NULL)`,
    mutation: "gist = 'mutated gist'"
  }
];

describe("indexed Recall governance snapshot identity", () => {
  it.each(ROWS)("includes same-time insert/update/delete in $table without cross-workspace churn", ({ table, insert, mutation }) => {
    const { database, projection } = fixture();
    const other = projection.observablePin("other");
    const before = projection.observablePin("workspace");
    database.connection.exec(insert);
    const inserted = projection.observablePin("workspace");
    expect(inserted.source_revision).not.toBe(before.source_revision);
    database.connection.exec(`UPDATE ${table} SET ${mutation}`);
    const updated = projection.observablePin("workspace");
    expect(updated.source_revision).not.toBe(inserted.source_revision);
    expect(updated.applied_at).toBe(before.applied_at);
    database.connection.exec(`UPDATE ${table} SET ${mutation}`);
    expect(projection.observablePin("workspace")).toEqual(updated);
    database.connection.exec(`DELETE FROM ${table}`);
    expect(projection.observablePin("workspace").source_revision).not.toBe(updated.source_revision);
    expect(projection.observablePin("other")).toEqual(other);
  });

  it("binds canonical temporal selection and active generation metadata without relying on timestamps", () => {
    const { database, projection } = fixture();
    const before = projection.observablePin("workspace");
    database.connection.exec("UPDATE temporal_schema_state SET projection_refresh_required=1 WHERE state_id=1");
    const stateChanged = projection.observablePin("workspace");
    expect(stateChanged.source_revision).not.toBe(before.source_revision);
    expect(stateChanged.applied_at).toBe(before.applied_at);
    database.connection.exec(`UPDATE temporal_projection_generations SET status='retired'
      WHERE generation=(SELECT active_projection_generation FROM temporal_schema_state WHERE state_id=1)`);
    const generationChanged = projection.observablePin("workspace");
    expect(generationChanged.source_revision).not.toBe(stateChanged.source_revision);
    database.connection.exec("UPDATE temporal_schema_state SET updated_at='2099-01-01T00:00:00.000Z' WHERE state_id=1");
    expect(projection.observablePin("workspace")).toEqual(generationChanged);
  });
});
