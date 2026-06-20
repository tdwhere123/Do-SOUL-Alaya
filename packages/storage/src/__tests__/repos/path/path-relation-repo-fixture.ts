import { PathAnchorRefSchema, type PathRelation } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqlitePathRelationRepo } from "../../../repos/path/path-relation-repo.js";

export const trackedDatabases = new Set<StorageDatabase>();

// invariant: the backing-id-coverage guard reads anchor discriminant kinds
// from the protocol schema rather than a hardcoded list, so the live union is
// always the source of truth for what the CASE must cover.
// PathAnchorRefSchema is a discriminatedUnion wrapped in .readonly(); unwrap
// _def.innerType to reach .options.
// cross-file ref: packages/protocol/src/soul/path-relation.ts PathAnchorRefSchema
export function anchorKindsFromSchema(): readonly string[] {
  const wrapped = PathAnchorRefSchema as unknown as {
    readonly _def: {
      readonly innerType: {
        readonly options: ReadonlyArray<{ readonly shape: { readonly kind: { readonly value: string } } }>;
      };
    };
  };
  return wrapped._def.innerType.options.map((member) => member.shape.kind.value);
}


// Byte-identical reconstruction of the anchor-key SQL the repo prepares
// (path-relation-repo.ts anchorKeySql). Used only by the byte-identity test to
// assert the rendered branch appears verbatim in the migration 048 index; the
// EXPLAIN test runs the repo's own prepared statements instead.
// cross-file ref: migrations/048-path-relations-and-event-log-indexes.sql.
export function reconstructedAnchorKeySql(anchorPath: "source_anchor" | "target_anchor"): string {
  return `CASE json_extract(anchors_json, '$.${anchorPath}.kind')
      WHEN 'object' THEN json_array('object', json_extract(anchors_json, '$.${anchorPath}.object_id'))
      WHEN 'object_facet' THEN json_array(
        'object_facet',
        json_extract(anchors_json, '$.${anchorPath}.object_id'),
        json_extract(anchors_json, '$.${anchorPath}.facet_key')
      )
      WHEN 'obligation' THEN json_array(
        'obligation',
        json_extract(anchors_json, '$.${anchorPath}.source_object_id'),
        json_extract(anchors_json, '$.${anchorPath}.obligation_digest')
      )
      WHEN 'risk_concern' THEN json_array(
        'risk_concern',
        json_extract(anchors_json, '$.${anchorPath}.source_object_id'),
        json_extract(anchors_json, '$.${anchorPath}.concern_digest')
      )
      WHEN 'time_concern' THEN json_array(
        'time_concern',
        json_extract(anchors_json, '$.${anchorPath}.source_object_id'),
        json_extract(anchors_json, '$.${anchorPath}.window_digest')
      )
    END`;
}

export function createRepo(options?: {
  readonly parsedRowCacheMax?: number;
}): {
  readonly database: StorageDatabase;
  readonly repo: SqlitePathRelationRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  trackedDatabases.add(database);
  seedWorkspace(database, "workspace-1");

  return {
    database,
    repo: new SqlitePathRelationRepo(database, options)
  };
}

export function withActiveLifecycle(relation: PathRelation): PathRelation {
  return {
    ...relation,
    lifecycle: {
      status: "active",
      ...relation.lifecycle
    }
  } as PathRelation;
}

export function seedWorkspace(database: StorageDatabase, workspaceId: string): void {
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
      "Path Relation Workspace",
      `/tmp/${workspaceId}`,
      "local_repo",
      null,
      "active",
      "2026-04-17T00:00:00.000Z",
      null,
      null
    );
}

export function createPathRelationFixture(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: {
        kind: "object",
        object_id: "object-1"
      },
      target_anchor: {
        kind: "object_facet",
        object_id: "object-2",
        facet_key: "status"
      }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["evidence_alignment"]
    },
    effect_vector: {
      salience: 0.4,
      recall_bias: 0.5,
      verification_bias: 0.2,
      unfinishedness_bias: 0.1,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.5,
      direction_bias: "source_to_target",
      stability_class: "volatile",
      support_events_count: 2,
      contradiction_events_count: 0,
      last_reinforced_at: "2026-04-17T00:00:00.000Z"
    },
    lifecycle: {
      retirement_rule: "retire_after_cooldown",
      cooldown_rule: "7d_without_support"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "hint_only"
    },
    created_at: "2026-04-17T00:00:00.000Z",
    updated_at: "2026-04-17T00:00:00.000Z",
    ...overrides
  };
}

export function insertRawPathRelationRow(
  database: StorageDatabase,
  overrides: {
    pathId: string;
    workspaceId?: string;
    anchorsJson?: string;
    constitutionJson?: string;
    effectVectorJson?: string;
    plasticityStateJson?: string;
    lifecycleJson?: string;
    legitimacyJson?: string;
    createdAt?: string;
    updatedAt?: string;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO path_relations (
        path_id,
        workspace_id,
        anchors_json,
        constitution_json,
        effect_vector_json,
        plasticity_state_json,
        lifecycle_json,
        legitimacy_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      overrides.pathId,
      overrides.workspaceId ?? "workspace-1",
      overrides.anchorsJson ??
        JSON.stringify({
          source_anchor: {
            kind: "object",
            object_id: "object-1"
          },
          target_anchor: {
            kind: "object_facet",
            object_id: "object-2",
            facet_key: "status"
          }
        }),
      overrides.constitutionJson ??
        JSON.stringify({
          relation_kind: "supports",
          why_this_relation_exists: ["evidence_alignment"]
        }),
      overrides.effectVectorJson ??
        JSON.stringify({
          salience: 0.4,
          recall_bias: 0.5,
          verification_bias: 0.2,
          unfinishedness_bias: 0.1,
          default_manifestation_preference: "stance_bias"
        }),
      overrides.plasticityStateJson ??
        JSON.stringify({
          strength: 0.5,
          direction_bias: "source_to_target",
          stability_class: "volatile",
          support_events_count: 2,
          contradiction_events_count: 0,
          last_reinforced_at: "2026-04-17T00:00:00.000Z"
        }),
      overrides.lifecycleJson ??
        JSON.stringify({
          retirement_rule: "retire_after_cooldown",
          cooldown_rule: "7d_without_support"
        }),
      overrides.legitimacyJson ??
        JSON.stringify({
          evidence_basis: ["evidence-1"],
          governance_class: "hint_only"
        }),
      overrides.createdAt ?? "2026-04-17T00:00:00.000Z",
      overrides.updatedAt ?? "2026-04-17T00:00:00.000Z"
    );
}
