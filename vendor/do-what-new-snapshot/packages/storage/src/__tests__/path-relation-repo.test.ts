import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { PathAnchorRef, PathRelation } from "@do-what/protocol";
import { serializePathAnchorRef } from "@do-what/protocol";
import { initDatabase, type StorageDatabase } from "../db.js";
import { SqlitePathRelationRepo } from "../repos/path-relation-repo.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqlitePathRelationRepo", () => {
  it("creates path relations and loads them by id, workspace, anchor, and active scope", async () => {
    const { repo } = createRepo();
    const first = createPathRelationFixture();
    const second = createPathRelationFixture({
      path_id: "path-2",
      anchors: {
        source_anchor: {
          kind: "object",
          object_id: "object-3"
        },
        target_anchor: {
          kind: "object",
          object_id: "object-1"
        }
      },
      created_at: "2026-04-17T00:01:00.000Z",
      updated_at: "2026-04-17T00:01:00.000Z"
    });

    await expect(repo.create(first)).resolves.toEqual(first);
    await expect(repo.create(second)).resolves.toEqual(second);
    await expect(repo.findById(first.path_id)).resolves.toEqual(first);
    await expect(repo.findByWorkspace(first.workspace_id)).resolves.toEqual([first, second]);
    await expect(
      repo.findByAnchor(first.workspace_id, {
        kind: "object",
        object_id: "object-1"
      })
    ).resolves.toEqual([first, second]);
    await expect(repo.findActive(first.workspace_id)).resolves.toEqual([first, second]);
  });

  it("scopes anchor lookups to a single workspace", async () => {
    const { repo, database } = createRepo();
    seedWorkspace(database, "workspace-2");

    const workspaceOneRelation = createPathRelationFixture();
    const workspaceTwoRelation = createPathRelationFixture({
      path_id: "path-2",
      workspace_id: "workspace-2",
      created_at: "2026-04-17T00:01:00.000Z",
      updated_at: "2026-04-17T00:01:00.000Z"
    });

    await repo.create(workspaceOneRelation);
    await repo.create(workspaceTwoRelation);

    await expect(
      repo.findByAnchor("workspace-1", {
        kind: "object",
        object_id: "object-1"
      })
    ).resolves.toEqual([workspaceOneRelation]);
    await expect(
      repo.findByAnchor("workspace-2", {
        kind: "object",
        object_id: "object-1"
      })
    ).resolves.toEqual([workspaceTwoRelation]);
  });

  it("findByAnchor ignores unrelated malformed workspace rows", async () => {
    const { repo, database } = createRepo();
    const matchingRelation = createPathRelationFixture();

    await repo.create(matchingRelation);
    insertRawPathRelationRow(database, {
      pathId: "path-bad-anchor-neighbor",
      anchorsJson: JSON.stringify({
        source_anchor: {
          kind: "object",
          object_id: "object-99"
        },
        target_anchor: {
          kind: "object",
          object_id: "object-100"
        }
      }),
      effectVectorJson: "{",
      createdAt: "2026-04-17T00:01:00.000Z",
      updatedAt: "2026-04-17T00:01:00.000Z"
    });

    await expect(
      repo.findByAnchor("workspace-1", {
        kind: "object",
        object_id: "object-1"
      })
    ).resolves.toEqual([matchingRelation]);
  });

  it("finds path relations for every PathAnchorRef variant", async () => {
    const { repo } = createRepo();
    const cases: ReadonlyArray<{
      readonly anchor: PathAnchorRef;
      readonly relation: PathRelation;
    }> = [
      {
        anchor: {
          kind: "object",
          object_id: "object-anchor"
        },
        relation: createPathRelationFixture({
          path_id: "path-object",
          anchors: {
            source_anchor: {
              kind: "object",
              object_id: "object-anchor"
            },
            target_anchor: {
              kind: "object",
              object_id: "object-target"
            }
          }
        })
      },
      {
        anchor: {
          kind: "object_facet",
          object_id: "object-facet-anchor",
          facet_key: "status"
        },
        relation: createPathRelationFixture({
          path_id: "path-object-facet",
          anchors: {
            source_anchor: {
              kind: "object",
              object_id: "object-facet-target"
            },
            target_anchor: {
              kind: "object_facet",
              object_id: "object-facet-anchor",
              facet_key: "status"
            }
          }
        })
      },
      {
        anchor: {
          kind: "obligation",
          source_object_id: "object-obligation-anchor",
          obligation_digest: "obligation-digest"
        },
        relation: createPathRelationFixture({
          path_id: "path-obligation",
          anchors: {
            source_anchor: {
              kind: "obligation",
              source_object_id: "object-obligation-anchor",
              obligation_digest: "obligation-digest"
            },
            target_anchor: {
              kind: "object",
              object_id: "object-obligation-target"
            }
          }
        })
      },
      {
        anchor: {
          kind: "risk_concern",
          source_object_id: "object-risk-anchor",
          concern_digest: "risk-digest"
        },
        relation: createPathRelationFixture({
          path_id: "path-risk-concern",
          anchors: {
            source_anchor: {
              kind: "object",
              object_id: "object-risk-target"
            },
            target_anchor: {
              kind: "risk_concern",
              source_object_id: "object-risk-anchor",
              concern_digest: "risk-digest"
            }
          }
        })
      },
      {
        anchor: {
          kind: "time_concern",
          source_object_id: "object-time-anchor",
          window_digest: "time-window-digest"
        },
        relation: createPathRelationFixture({
          path_id: "path-time-concern",
          anchors: {
            source_anchor: {
              kind: "time_concern",
              source_object_id: "object-time-anchor",
              window_digest: "time-window-digest"
            },
            target_anchor: {
              kind: "object",
              object_id: "object-time-target"
            }
          }
        })
      }
    ];

    for (const entry of cases) {
      await repo.create(entry.relation);
    }

    for (const entry of cases) {
      await expect(repo.findByAnchor("workspace-1", entry.anchor)).resolves.toEqual([entry.relation]);
    }
  });

  it("reuses the shared protocol anchor serializer on both the SQL and caller lookup paths", async () => {
    const repoSource = await readFile(new URL("../repos/path-relation-repo.ts", import.meta.url), "utf8");

    expect(repoSource).toContain("serialize_path_anchor_ref(");
    expect(repoSource).toContain("serializePathAnchorRef,");

    const { database, repo } = createRepo();
    const anchor = {
      kind: "time_concern",
      source_object_id: "object-shared-time",
      window_digest: "next_week"
    } as const;
    const relation = createPathRelationFixture({
      path_id: "path-shared-serializer",
      anchors: {
        source_anchor: anchor,
        target_anchor: {
          kind: "object",
          object_id: "object-target"
        }
      }
    });

    await repo.create(relation);

    const row = database.connection
      .prepare("SELECT serialize_path_anchor_ref(?) AS anchor_key")
      .get(JSON.stringify(anchor)) as { readonly anchor_key: string | null };

    expect(row.anchor_key).toBe(serializePathAnchorRef(anchor));
    expect(serializePathAnchorRef(anchor)).toBe(JSON.stringify(["time_concern", "object-shared-time", "next_week"]));
    await expect(repo.findByAnchor("workspace-1", anchor)).resolves.toEqual([relation]);
  });

  it("updates mutable contract sections without changing anchors or constitution", async () => {
    const { repo } = createRepo();
    const relation = createPathRelationFixture();
    await repo.create(relation);

    const updated = await repo.update(relation.path_id, {
      effect_vector: {
        ...relation.effect_vector,
        salience: 0.9
      },
      plasticity_state: {
        ...relation.plasticity_state,
        strength: 0.8,
        support_events_count: 4
      },
      legitimacy: {
        evidence_basis: ["evidence-3"],
        governance_class: "recall_allowed"
      },
      updated_at: "2026-04-17T00:02:00.000Z"
    });

    expect(updated).toEqual({
      ...relation,
      effect_vector: {
        ...relation.effect_vector,
        salience: 0.9
      },
      plasticity_state: {
        ...relation.plasticity_state,
        strength: 0.8,
        support_events_count: 4
      },
      legitimacy: {
        evidence_basis: ["evidence-3"],
        governance_class: "recall_allowed"
      },
      updated_at: "2026-04-17T00:02:00.000Z"
    });
    expect(updated.anchors).toEqual(relation.anchors);
    expect(updated.constitution).toEqual(relation.constitution);
  });

  it("findActive only returns rows that match the current Wave 1 lifecycle shape", async () => {
    const { repo, database } = createRepo();
    const relation = createPathRelationFixture();

    await repo.create(relation);
    insertRawPathRelationRow(database, {
      pathId: "path-future-only-active",
      lifecycleJson: JSON.stringify({
        status: "active"
      }),
      createdAt: "2026-04-17T00:02:00.000Z",
      updatedAt: "2026-04-17T00:02:00.000Z"
    });

    await expect(repo.findActive("workspace-1")).resolves.toEqual([relation]);
  });

  it("deletes path relations", async () => {
    const { repo } = createRepo();
    const relation = createPathRelationFixture();
    await repo.create(relation);

    await repo.delete(relation.path_id);

    await expect(repo.findById(relation.path_id)).resolves.toBeNull();
    await expect(repo.findByWorkspace(relation.workspace_id)).resolves.toEqual([]);
  });
});

function createRepo(): {
  readonly database: StorageDatabase;
  readonly repo: SqlitePathRelationRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  seedWorkspace(database, "workspace-1");

  return {
    database,
    repo: new SqlitePathRelationRepo(database)
  };
}

function seedWorkspace(database: StorageDatabase, workspaceId: string): void {
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

function createPathRelationFixture(overrides: Partial<PathRelation> = {}): PathRelation {
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

function insertRawPathRelationRow(
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
