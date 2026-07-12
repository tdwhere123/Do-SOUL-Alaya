import { afterEach, describe, expect, it } from "vitest";
import type { PathAnchorRef, PathRelation } from "@do-soul/alaya-protocol";
import {
  createPathRelationFixture,
  createRepo,
  insertRawPathRelationRow,
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

  it("caps default workspace/active/dormant lists and exposes explicit full-list methods", async () => {
    const { repo } = createRepo();
    const dormantCutoff = "2026-04-17T00:00:00.000Z";

    for (let index = 0; index < 501; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 3, 16, 0, 0, index)).toISOString();
      repo.create(
        createPathRelationFixture({
          path_id: `path-active-${index}`,
          created_at: timestamp,
          updated_at: timestamp
        })
      );
      repo.create(
        createPathRelationFixture({
          path_id: `path-dormant-${index}`,
          lifecycle: {
            retirement_rule: "retire_after_cooldown",
            cooldown_rule: "7d_without_support",
            status: "dormant"
          },
          created_at: timestamp,
          updated_at: timestamp
        })
      );
    }

    await expect(repo.findByWorkspace("workspace-1")).resolves.toHaveLength(500);
    await expect(repo.findByWorkspaceAll("workspace-1")).resolves.toHaveLength(1002);
    await expect(repo.findActive("workspace-1")).resolves.toHaveLength(500);
    await expect(repo.findActiveAll("workspace-1")).resolves.toHaveLength(501);
    await expect(repo.findDormant("workspace-1", dormantCutoff)).resolves.toHaveLength(500);
    await expect(repo.findDormantAll("workspace-1", dormantCutoff)).resolves.toHaveLength(501);
    await expect(repo.findActivePage("workspace-1", { limit: 501, offset: 0 })).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
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

  it("rejects rows whose JSON parses but violates the path-relation field schema", async () => {
    const { repo, database } = createRepo();
    insertRawPathRelationRow(database, {
      pathId: "path-invalid-shape",
      effectVectorJson: JSON.stringify({
        recall_bias: 0.5
      })
    });

    await expect(repo.findById("path-invalid-shape")).rejects.toMatchObject({
      name: "StorageError",
      code: "VALIDATION_FAILED"
    });
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

  it("findByBackingObjectIds preserves backing-anchor semantics", async () => {
    const { repo } = createRepo();
    const facetRelation = createPathRelationFixture({
      path_id: "path-facet-backing",
      anchors: {
        source_anchor: {
          kind: "object_facet",
          object_id: "object-source",
          facet_key: "status"
        },
        target_anchor: { kind: "object", object_id: "object-target" }
      }
    });
    const dualEndpointRelation = createPathRelationFixture({
      path_id: "path-dual-backing",
      anchors: {
        source_anchor: { kind: "object", object_id: "object-dual" },
        target_anchor: {
          kind: "time_concern",
          source_object_id: "object-dual",
          window_digest: "window"
        }
      },
      created_at: "2026-04-17T00:01:00.000Z",
      updated_at: "2026-04-17T00:01:00.000Z"
    });
    repo.create(facetRelation);
    repo.create(dualEndpointRelation);

    await expect(
      repo.findByBackingObjectIds("workspace-1", [
        "object-source",
        "object-dual",
        "object-source"
      ])
    ).resolves.toEqual([
      withActiveLifecycle(facetRelation),
      withActiveLifecycle(dualEndpointRelation)
    ]);
  });

  it("findByBackingObjectIds avoids storage reads for an empty input", async () => {
    const { repo } = createRepo();

    await expect(repo.findByBackingObjectIds("workspace-1", [])).resolves.toEqual([]);
  });

  it("findByBackingObjectIds batches beyond the conservative SQLite variable limit", async () => {
    const { repo } = createRepo();
    const objectIds = Array.from({ length: 501 }, (_, index) => `object-bulk-${index}`);
    for (const [index, objectId] of objectIds.entries()) {
      repo.create(createPathRelationFixture({
        path_id: `path-bulk-${index}`,
        anchors: {
          source_anchor: { kind: "object", object_id: objectId },
          target_anchor: { kind: "object", object_id: `target-bulk-${index}` }
        },
        created_at: new Date(Date.UTC(2026, 3, 17, 0, 0, index)).toISOString(),
        updated_at: new Date(Date.UTC(2026, 3, 17, 0, 0, index)).toISOString()
      }));
    }

    const results = await repo.findByBackingObjectIds("workspace-1", objectIds);

    expect(results).toHaveLength(objectIds.length);
    expect(results.map((relation) => relation.path_id)).toEqual(
      objectIds.map((_, index) => `path-bulk-${index}`)
    );
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

  it("adds paged variants without changing full-history workspace and lifecycle reads", async () => {
    const { repo } = createRepo();
    const first = createPathRelationFixture({ path_id: "path-page-1", created_at: "2026-04-17T00:00:00.000Z" });
    const second = createPathRelationFixture({
      path_id: "path-page-2",
      created_at: "2026-04-17T00:01:00.000Z",
      updated_at: "2026-04-17T00:01:00.000Z"
    });
    const dormant = createPathRelationFixture({
      path_id: "path-page-3",
      created_at: "2026-04-17T00:02:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      lifecycle: {
        ...first.lifecycle,
        status: "dormant"
      }
    });

    repo.create(first);
    repo.create(second);
    repo.create(dormant);

    await expect(repo.findByWorkspace("workspace-1")).resolves.toHaveLength(3);
    await expect(repo.findByWorkspacePage?.("workspace-1", { limit: 1, offset: 1 })).resolves.toEqual([
      withActiveLifecycle(second)
    ]);
    await expect(repo.findActive("workspace-1")).resolves.toEqual([
      withActiveLifecycle(first),
      withActiveLifecycle(second)
    ]);
    await expect(repo.findActivePage?.("workspace-1", { limit: 1, offset: 1 })).resolves.toEqual([
      withActiveLifecycle(second)
    ]);
    await expect(repo.findDormant("workspace-1", "2026-02-01T00:00:00.000Z")).resolves.toEqual([dormant]);
    await expect(
      repo.findDormantPage?.("workspace-1", "2026-02-01T00:00:00.000Z", { limit: 1, offset: 0 })
    ).resolves.toEqual([dormant]);
  });

});
