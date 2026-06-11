import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { PathAnchorRef, PathRelation } from "@do-soul/alaya-protocol";
import { PathAnchorRefSchema, serializePathAnchorRef } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../db.js";
import {
  PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL,
  PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL,
  SqlitePathRelationRepo
} from "../../repos/path-relation-repo.js";

// invariant: the backing-id-coverage guard reads anchor discriminant kinds
// from the protocol schema rather than a hardcoded list, so the live union is
// always the source of truth for what the CASE must cover.
// PathAnchorRefSchema is a discriminatedUnion wrapped in .readonly(); unwrap
// _def.innerType to reach .options.
// cross-file ref: packages/protocol/src/soul/path-relation.ts PathAnchorRefSchema
function anchorKindsFromSchema(): readonly string[] {
  const wrapped = PathAnchorRefSchema as unknown as {
    readonly _def: {
      readonly innerType: {
        readonly options: ReadonlyArray<{ readonly shape: { readonly kind: { readonly value: string } } }>;
      };
    };
  };
  return wrapped._def.innerType.options.map((member) => member.shape.kind.value);
}

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

    expect(repo.create(first)).toEqual(withActiveLifecycle(first));
    expect(repo.create(second)).toEqual(withActiveLifecycle(second));
    await expect(repo.findById(first.path_id)).resolves.toEqual(withActiveLifecycle(first));
    await expect(repo.findByWorkspace(first.workspace_id)).resolves.toEqual([
      withActiveLifecycle(first),
      withActiveLifecycle(second)
    ]);
    await expect(
      repo.findByAnchor(first.workspace_id, {
        kind: "object",
        object_id: "object-1"
      })
    ).resolves.toEqual([withActiveLifecycle(first), withActiveLifecycle(second)]);
    await expect(repo.findActive(first.workspace_id)).resolves.toEqual([
      withActiveLifecycle(first),
      withActiveLifecycle(second)
    ]);
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
    ).resolves.toEqual([withActiveLifecycle(workspaceOneRelation)]);
    await expect(
      repo.findByAnchor("workspace-2", {
        kind: "object",
        object_id: "object-1"
      })
    ).resolves.toEqual([withActiveLifecycle(workspaceTwoRelation)]);
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
    ).resolves.toEqual([withActiveLifecycle(matchingRelation)]);
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
      await expect(repo.findByAnchor("workspace-1", entry.anchor)).resolves.toEqual([
        withActiveLifecycle(entry.relation)
      ]);
    }
  });

  it("findByAnchors batches anchor lookups, dedupes dual-anchor rows, and keeps workspace scope", async () => {
    const { repo, database } = createRepo();
    seedWorkspace(database, "workspace-2");
    const dualAnchorRelation = createPathRelationFixture({
      path_id: "path-dual-anchor",
      anchors: {
        source_anchor: { kind: "object", object_id: "object-source" },
        target_anchor: { kind: "object", object_id: "object-target" }
      }
    });
    const neighboringRelation = createPathRelationFixture({
      path_id: "path-neighbor",
      anchors: {
        source_anchor: { kind: "object", object_id: "object-other" },
        target_anchor: { kind: "object", object_id: "object-target" }
      },
      created_at: "2026-04-17T00:01:00.000Z",
      updated_at: "2026-04-17T00:01:00.000Z"
    });
    const otherWorkspaceRelation = createPathRelationFixture({
      path_id: "path-other-workspace",
      workspace_id: "workspace-2",
      anchors: {
        source_anchor: { kind: "object", object_id: "object-source" },
        target_anchor: { kind: "object", object_id: "object-target" }
      }
    });

    repo.create(dualAnchorRelation);
    repo.create(neighboringRelation);
    repo.create(otherWorkspaceRelation);

    await expect(
      repo.findByAnchors("workspace-1", [
        { kind: "object", object_id: "object-source" },
        { kind: "object", object_id: "object-target" }
      ])
    ).resolves.toEqual([
      withActiveLifecycle(dualAnchorRelation),
      withActiveLifecycle(neighboringRelation)
    ]);
  });

  it("findByTargetAnchor returns only target-anchored rows, excluding source-anchored-only rows", async () => {
    const { repo } = createRepo();
    const inboundRelation = createPathRelationFixture({
      path_id: "path-inbound",
      anchors: {
        source_anchor: { kind: "object", object_id: "object-source" },
        target_anchor: { kind: "object", object_id: "object-pivot" }
      }
    });
    const outboundRelation = createPathRelationFixture({
      path_id: "path-outbound",
      anchors: {
        source_anchor: { kind: "object", object_id: "object-pivot" },
        target_anchor: { kind: "object", object_id: "object-other" }
      },
      created_at: "2026-04-17T00:01:00.000Z",
      updated_at: "2026-04-17T00:01:00.000Z"
    });

    repo.create(inboundRelation);
    repo.create(outboundRelation);

    // Target-anchored only: the inbound row (object-pivot is its target) is
    // returned; the outbound row (object-pivot is its source) is excluded.
    // findByAnchor would return both — findByTargetAnchor is the inbound half.
    await expect(
      repo.findByTargetAnchor("workspace-1", { kind: "object", object_id: "object-pivot" })
    ).resolves.toEqual([withActiveLifecycle(inboundRelation)]);
    await expect(
      repo.findByAnchor("workspace-1", { kind: "object", object_id: "object-pivot" })
    ).resolves.toEqual([
      withActiveLifecycle(inboundRelation),
      withActiveLifecycle(outboundRelation)
    ]);
  });

  it("findByTargetAnchor scopes to a single workspace", async () => {
    const { repo, database } = createRepo();
    seedWorkspace(database, "workspace-2");
    const workspaceOneRelation = createPathRelationFixture({
      path_id: "path-ws1",
      anchors: {
        source_anchor: { kind: "object", object_id: "object-source" },
        target_anchor: { kind: "object", object_id: "object-pivot" }
      }
    });
    const workspaceTwoRelation = createPathRelationFixture({
      path_id: "path-ws2",
      workspace_id: "workspace-2",
      anchors: {
        source_anchor: { kind: "object", object_id: "object-source" },
        target_anchor: { kind: "object", object_id: "object-pivot" }
      },
      created_at: "2026-04-17T00:01:00.000Z",
      updated_at: "2026-04-17T00:01:00.000Z"
    });

    repo.create(workspaceOneRelation);
    repo.create(workspaceTwoRelation);

    await expect(
      repo.findByTargetAnchor("workspace-1", { kind: "object", object_id: "object-pivot" })
    ).resolves.toEqual([withActiveLifecycle(workspaceOneRelation)]);
  });

  it("keeps the anchor-key SQL byte-identical to the migration 048 index expression", async () => {
    const repoSource = await readFile(new URL("../../repos/path-relation-repo.ts", import.meta.url), "utf8");
    const indexSource = await readFile(
      new URL("../../migrations/048-path-relations-and-event-log-indexes.sql", import.meta.url),
      "utf8"
    );

    // The drifted serialize_path_anchor_ref SQL function defeated the index;
    // the repo must no longer register or query it.
    expect(repoSource).not.toContain("serialize_path_anchor_ref(");
    // The bound-param side still uses the protocol serializer (its JSON text
    // equals what the indexed json_array expression renders).
    expect(repoSource).toContain("serializePathAnchorRef,");

    // The rendered anchor-key predicate (this test reconstructs it via the same
    // template the repo uses) must appear verbatim in the indexed expression,
    // normalized only for whitespace. This is the byte-identity contract; the
    // EXPLAIN QUERY PLAN test below proves the planner actually picks the index.
    const normalize = (text: string): string => text.replace(/\s+/gu, " ").trim();
    const normalizedIndex = normalize(indexSource);
    for (const anchorPath of ["source_anchor", "target_anchor"] as const) {
      const normalizedBranch = normalize(reconstructedAnchorKeySql(anchorPath));
      expect(normalizedIndex).toContain(normalizedBranch);
    }

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

    // The indexed source-anchor expression (copied from migration 048) must
    // render the same text the bound parameter carries, or the predicate could
    // never match the index even when both sides "look" equal.
    const row = database.connection
      .prepare(
        `SELECT
          CASE json_extract(anchors_json, '$.source_anchor.kind')
            WHEN 'time_concern' THEN json_array(
              'time_concern',
              json_extract(anchors_json, '$.source_anchor.source_object_id'),
              json_extract(anchors_json, '$.source_anchor.window_digest')
            )
          END AS anchor_key
        FROM path_relations
        WHERE path_id = ?`
      )
      .get(relation.path_id) as { readonly anchor_key: string | null };

    expect(row.anchor_key).toBe(serializePathAnchorRef(anchor));
    expect(serializePathAnchorRef(anchor)).toBe(JSON.stringify(["time_concern", "object-shared-time", "next_week"]));
    await expect(repo.findByAnchor("workspace-1", anchor)).resolves.toEqual([
      withActiveLifecycle(relation)
    ]);
  });

  it("updates mutable contract sections without changing anchors or constitution", async () => {
    const { repo } = createRepo();
    const relation = createPathRelationFixture();
    repo.create(relation);

    const updated = repo.update(relation.path_id, {
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
      ...withActiveLifecycle(relation),
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

    repo.create(relation);
    insertRawPathRelationRow(database, {
      pathId: "path-future-only-active",
      lifecycleJson: JSON.stringify({
        status: "active"
      }),
      createdAt: "2026-04-17T00:02:00.000Z",
      updatedAt: "2026-04-17T00:02:00.000Z"
    });
    insertRawPathRelationRow(database, {
      pathId: "path-retired",
      lifecycleJson: JSON.stringify({
        status: "retired",
        retirement_rule: "retire_after_cooldown"
      }),
      createdAt: "2026-04-17T00:03:00.000Z",
      updatedAt: "2026-04-17T00:03:00.000Z"
    });

    await expect(repo.findActive("workspace-1")).resolves.toEqual([withActiveLifecycle(relation)]);
  });

  it("findDormant returns only dormant rows whose updated_at is older than the threshold", async () => {
    const { repo, database } = createRepo();

    // Active rows are never dormant candidates.
    repo.create(createPathRelationFixture({ path_id: "path-active" }));

    // A dormant row last touched well before the threshold: a candidate.
    insertRawPathRelationRow(database, {
      pathId: "path-dormant-old",
      lifecycleJson: JSON.stringify({
        status: "dormant",
        retirement_rule: "retire_after_cooldown",
        cooldown_rule: "7d_without_support"
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-10T00:00:00.000Z"
    });

    // A dormant row touched after the threshold: too fresh, excluded.
    insertRawPathRelationRow(database, {
      pathId: "path-dormant-fresh",
      lifecycleJson: JSON.stringify({
        status: "dormant",
        retirement_rule: "retire_after_cooldown",
        cooldown_rule: "7d_without_support"
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });

    // A retired row is terminal, never a dormant candidate even if old.
    insertRawPathRelationRow(database, {
      pathId: "path-retired-old",
      lifecycleJson: JSON.stringify({
        status: "retired",
        retirement_rule: "retire_after_cooldown"
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-10T00:00:00.000Z"
    });

    const dormant = await repo.findDormant("workspace-1", "2026-02-01T00:00:00.000Z");
    expect(dormant.map((relation) => relation.path_id)).toEqual(["path-dormant-old"]);
  });

  it("findDormant scopes to a single workspace", async () => {
    const { repo, database } = createRepo();
    seedWorkspace(database, "workspace-2");

    insertRawPathRelationRow(database, {
      pathId: "path-ws1-dormant",
      workspaceId: "workspace-1",
      lifecycleJson: JSON.stringify({
        status: "dormant",
        retirement_rule: "retire_after_cooldown"
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-10T00:00:00.000Z"
    });
    insertRawPathRelationRow(database, {
      pathId: "path-ws2-dormant",
      workspaceId: "workspace-2",
      lifecycleJson: JSON.stringify({
        status: "dormant",
        retirement_rule: "retire_after_cooldown"
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-10T00:00:00.000Z"
    });

    const dormant = await repo.findDormant("workspace-1", "2026-02-01T00:00:00.000Z");
    expect(dormant.map((relation) => relation.path_id)).toEqual(["path-ws1-dormant"]);
  });

  it("deletes path relations", async () => {
    const { repo } = createRepo();
    const relation = createPathRelationFixture();
    repo.create(relation);

    await repo.delete(relation.path_id);

    await expect(repo.findById(relation.path_id)).resolves.toBeNull();
    await expect(repo.findByWorkspace(relation.workspace_id)).resolves.toEqual([]);
  });

  // I2 regression: the anchor lookups must ride the migration 048 expression
  // indexes, not degrade to a workspace SCAN. EXPLAIN QUERY PLAN runs over the
  // SQL text the repo's OWN prepared statements carry (via .source) so a drift
  // between the indexed expression and the live statement fails this test — a
  // reconstruction could pass while the private statement drifted.
  it("findByAnchor / findByAnchors / findByTargetAnchor ride the anchor indexes (no workspace scan)", () => {
    const { database, repo } = createRepo();
    const repoSql = repo.__anchorLookupSqlForTest();

    const explainUsesAnchorIndex = (sql: string, params: readonly unknown[]): void => {
      const plan = database.connection
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params) as ReadonlyArray<{ readonly detail: string }>;
      const details = plan.map((step) => step.detail).join(" | ");
      expect(
        plan.some(
          (step) =>
            step.detail.includes("USING INDEX idx_path_relations_source_anchor_key") ||
            step.detail.includes("USING INDEX idx_path_relations_target_anchor_key")
        ),
        `expected an anchor index SEARCH, got: ${details}`
      ).toBe(true);
      expect(
        plan.some((step) => step.detail.startsWith("SCAN")),
        `expected no SCAN step, got: ${details}`
      ).toBe(false);
    };

    // The REAL prepared statements: findByAnchor (source side) and
    // findByTargetAnchor (target side).
    explainUsesAnchorIndex(repoSql.findBySourceAnchor, ["workspace-1", '["object","object-1"]']);
    explainUsesAnchorIndex(repoSql.findByTargetAnchor, ["workspace-1", '["object","object-1"]']);
    // findByAnchors fans out an IN-list over source OR target; both arms must
    // still resolve through the anchor indexes. Rendered by the same builder the
    // production path prepares.
    explainUsesAnchorIndex(repoSql.findByAnchors(2), [
      "workspace-1",
      '["object","object-1"]',
      '["object","object-2"]',
      '["object","object-1"]',
      '["object","object-2"]'
    ]);
  });

  // I2 regression (migration 087): findByBackingObjectId resolves rows by the
  // backing memory object id of each anchor variant (a UNION ALL of a source-side
  // and target-side lookup). Each arm must ride the migration-087 backing-object
  // expression indexes, not degrade to a workspace SCAN — proven over the repo's
  // OWN prepared statement (.source), so a drift between the indexed expression
  // and the live statement fails this test.
  it("findByBackingObjectId rides the migration-087 backing-object indexes (no workspace scan)", () => {
    const { database, repo } = createRepo();
    const repoSql = repo.__anchorLookupSqlForTest();

    const plan = database.connection
      .prepare(`EXPLAIN QUERY PLAN ${repoSql.findByBackingObjectId}`)
      .all("workspace-1", "object-1", "workspace-1", "object-1") as ReadonlyArray<{
      readonly detail: string;
    }>;
    const details = plan.map((step) => step.detail).join(" | ");

    // Both UNION ALL arms must SEARCH via a backing-object expression index.
    const indexSearches = plan.filter(
      (step) =>
        step.detail.includes("USING INDEX idx_path_relations_source_backing_object_id") ||
        step.detail.includes("USING INDEX idx_path_relations_target_backing_object_id")
    );
    expect(
      indexSearches.length,
      `expected two backing-object index SEARCHes (one per UNION arm), got: ${details}`
    ).toBe(2);
    expect(
      plan.some((step) => step.detail.startsWith("SCAN")),
      `expected no SCAN step, got: ${details}`
    ).toBe(false);
  });

  // invariant: anchorBackingObjectIdSql has no ELSE, so an anchor kind absent
  // from its CASE returns NULL and `NULL IN (...)` never matches — such a kind
  // escapes cascade pruning (orphaned topology). This guard fails when a kind
  // exists in PathAnchorRefSchema without a matching WHEN branch in the
  // backing-id SQL, forcing a conscious coverage decision.
  // cross-file ref: packages/storage/src/repos/path-relation-repo.ts anchorBackingObjectIdSql
  it("backing-id SQL covers every PathAnchorRef kind (no silently-unpruned kind)", () => {
    const kinds = anchorKindsFromSchema();
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      const branch = `WHEN '${kind}' THEN`;
      expect(
        PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL.includes(branch),
        `source backing-id SQL is missing a WHEN branch for anchor kind '${kind}'`
      ).toBe(true);
      expect(
        PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL.includes(branch),
        `target backing-id SQL is missing a WHEN branch for anchor kind '${kind}'`
      ).toBe(true);
    }
  });
});

// Byte-identical reconstruction of the anchor-key SQL the repo prepares
// (path-relation-repo.ts anchorKeySql). Used only by the byte-identity test to
// assert the rendered branch appears verbatim in the migration 048 index; the
// EXPLAIN test runs the repo's own prepared statements instead.
// cross-file ref: migrations/048-path-relations-and-event-log-indexes.sql.
function reconstructedAnchorKeySql(anchorPath: "source_anchor" | "target_anchor"): string {
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

function withActiveLifecycle(relation: PathRelation): PathRelation {
  return {
    ...relation,
    lifecycle: {
      status: "active",
      ...relation.lifecycle
    }
  } as PathRelation;
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
