import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { serializePathAnchorRef } from "@do-soul/alaya-protocol";
import {
  PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL,
  PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL
} from "../../../repos/path/path-relation-repo.js";
import { findByBackingObjectIdsSql } from "../../../repos/path/path-relation-sql.js";
import {
  anchorKindsFromSchema,
  createPathRelationFixture,
  createRepo,
  insertRawPathRelationRow,
  reconstructedAnchorKeySql,
  seedWorkspace,
  trackedDatabases,
  withActiveLifecycle
} from "./path-relation-repo-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqlitePathRelationRepo SQL planner and cache behavior", () => {
  it("keeps the anchor-key SQL byte-identical to the migration 048 index expression", async () => {
    const repoSource = await readFile(new URL("../../../repos/path/path-relation-repo.ts", import.meta.url), "utf8");
    const readQueriesSource = await readFile(
      new URL("../../../repos/path/path-relation-read-queries.ts", import.meta.url),
      "utf8"
    );
    const indexSource = await readFile(
      new URL("../../../migrations/048-path-relations-and-event-log-indexes.sql", import.meta.url),
      "utf8"
    );
    const baseIndexSource = await readFile(new URL("../../../migrations/042-path-relations.sql", import.meta.url), "utf8");

    // The drifted serialize_path_anchor_ref SQL function defeated the index;
    // the repo must no longer register or query it.
    expect(repoSource).not.toContain("serialize_path_anchor_ref(");
    // The bound-param side still uses the protocol serializer (its JSON text
    // equals what the indexed json_array expression renders).
    expect(readQueriesSource).toContain("serializePathAnchorRef");

    // The rendered anchor-key predicate (this test reconstructs it via the same
    // template the repo uses) must appear verbatim in the indexed expression,
    // normalized only for whitespace. This is the byte-identity contract; the
    // EXPLAIN QUERY PLAN test below proves the planner actually picks the index.
    const normalize = (text: string): string => text.replace(/\s+/gu, " ").trim();
    const normalizedIndex = normalize(indexSource);
    const normalizedBaseIndex = normalize(baseIndexSource);
    expect(normalizedBaseIndex).toContain("CREATE INDEX idx_path_relations_workspace ON path_relations(workspace_id);");
    expect(normalizedIndex).toContain("CREATE INDEX idx_path_relations_source_anchor_key");
    expect(normalizedIndex).toContain("CREATE INDEX idx_path_relations_target_anchor_key");
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

    const indexNames = (
      database.connection.prepare("PRAGMA index_list('path_relations')").all() as Array<{ readonly name: string }>
    ).map((row) => row.name);
    expect(indexNames).toContain("idx_path_relations_workspace");
    expect(indexNames).toContain("idx_path_relations_source_anchor_key");
    expect(indexNames).toContain("idx_path_relations_target_anchor_key");
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

  it("memoizes row parses by (path_id, updated_at) and evicts on update, delete, and re-create", async () => {
    const { repo } = createRepo();
    const relation = createPathRelationFixture();
    repo.create(relation);

    const first = await repo.findById(relation.path_id);
    const second = await repo.findById(relation.path_id);
    // Same frozen instance: the deep zod parse ran once for the unchanged row.
    expect(second).toBe(first);

    // An update that does NOT bump updated_at must still invalidate the memo.
    repo.update(relation.path_id, {
      effect_vector: {
        ...relation.effect_vector,
        salience: 0.9
      }
    });
    const afterUpdate = await repo.findById(relation.path_id);
    expect(afterUpdate?.effect_vector.salience).toBe(0.9);

    await repo.delete(relation.path_id);
    repo.create({
      ...relation,
      legitimacy: {
        ...relation.legitimacy,
        evidence_basis: ["evidence-recreated"]
      }
    });
    const recreated = await repo.findById(relation.path_id);
    expect(recreated?.legitimacy.evidence_basis).toEqual(["evidence-recreated"]);
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

  it("findByBackingObjectIds keeps both bulk lookup arms on backing-object indexes", () => {
    const { database } = createRepo();
    const plan = database.connection
      .prepare(`EXPLAIN QUERY PLAN ${findByBackingObjectIdsSql(2)}`)
      .all(
        "workspace-1",
        "object-1",
        "object-2",
        "workspace-1",
        "object-1",
        "object-2"
      ) as ReadonlyArray<{ readonly detail: string }>;
    const details = plan.map((step) => step.detail).join(" | ");
    const indexSearches = plan.filter(
      (step) =>
        step.detail.includes("USING INDEX idx_path_relations_source_backing_object_id") ||
        step.detail.includes("USING INDEX idx_path_relations_target_backing_object_id")
    );

    expect(indexSearches, details).toHaveLength(2);
    expect(plan.some((step) => step.detail.startsWith("SCAN")), details).toBe(false);
  });

  // invariant: anchorBackingObjectIdSql has no ELSE, so an anchor kind absent
  // from its CASE returns NULL and `NULL IN (...)` never matches — such a kind
  // escapes cascade pruning (orphaned topology). This guard fails when a kind
  // exists in PathAnchorRefSchema without a matching WHEN branch in the
  // backing-id SQL, forcing a conscious coverage decision.
  // cross-file ref: packages/storage/src/repos/path/path-relation-repo.ts anchorBackingObjectIdSql
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

  it("evicts only the least-recently-used parsed row instead of clearing the whole cache", async () => {
    const { database, repo } = createRepo({ parsedRowCacheMax: 2 });
    const first = createPathRelationFixture({ path_id: "path-cache-1" });
    const second = createPathRelationFixture({
      path_id: "path-cache-2",
      created_at: "2026-04-17T00:01:00.000Z",
      updated_at: "2026-04-17T00:01:00.000Z"
    });
    const third = createPathRelationFixture({
      path_id: "path-cache-3",
      created_at: "2026-04-17T00:02:00.000Z",
      updated_at: "2026-04-17T00:02:00.000Z"
    });

    repo.create(first);
    repo.create(second);
    repo.create(third);

    await expect(repo.findById(first.path_id)).resolves.toEqual(withActiveLifecycle(first));
    await expect(repo.findById(second.path_id)).resolves.toEqual(withActiveLifecycle(second));
    await expect(repo.findById(first.path_id)).resolves.toEqual(withActiveLifecycle(first));
    await expect(repo.findById(third.path_id)).resolves.toEqual(withActiveLifecycle(third));

    database.connection
      .prepare("UPDATE path_relations SET anchors_json = ? WHERE path_id = ?")
      .run(JSON.stringify({ source_anchor: { kind: "object", object_id: "object-cache-invalid" } }), first.path_id);
    database.connection
      .prepare("UPDATE path_relations SET anchors_json = ? WHERE path_id = ?")
      .run(JSON.stringify({ source_anchor: { kind: "object", object_id: "object-cache-invalid" } }), second.path_id);

    await expect(repo.findById(first.path_id)).resolves.toEqual(withActiveLifecycle(first));
    await expect(repo.findById(second.path_id)).rejects.toMatchObject({
      name: "StorageError",
      code: "VALIDATION_FAILED"
    });
  });
});
