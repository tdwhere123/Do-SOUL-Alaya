import { afterEach, describe, expect, it } from "vitest";
import type { PathRelation } from "@do-soul/alaya-protocol";
import { SqliteSoftAssociationPathRepo } from "../../../repos/path/soft-association/index.js";
import { markTemporalProjectionSelectedForTest } from "../../support/temporal-projection-selection.js";
import {
  createPathRelationFixture,
  createRepo,
  trackedDatabases
} from "./path-relation-repo-fixture.js";

afterEach(() => {
  for (const database of trackedDatabases) database.close();
  trackedDatabases.clear();
});

describe("SqliteSoftAssociationPathRepo", () => {
  it("reads only canonical usage paths within both historical write boundaries", async () => {
    const { database } = createRepo();
    const repo = new SqliteSoftAssociationPathRepo(database);
    const visible = canonicalPath({ path_id: "soft-visible" });
    const createdLater = canonicalPath({
      path_id: "soft-created-later",
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:00.000Z"
    });
    const updatedLater = canonicalPath({
      path_id: "soft-updated-later",
      created_at: "2026-04-16T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:00.000Z"
    });
    const offsetFuture = canonicalPath({
      path_id: "soft-offset-future",
      created_at: "2026-04-18T00:30:00.000Z",
      updated_at: "2026-04-18T00:30:00.000Z"
    });
    for (const path of [visible, createdLater, updatedLater, offsetFuture]) repo.create(path);

    await expect(repo.findActiveByWorkspace("workspace-1", {
      asOf: "2026-04-18T00:00:00.000Z"
    })).resolves.toEqual([visible]);
    await expect(repo.findByAnchors("workspace-1", [{
      kind: "object",
      object_id: "object-1"
    }])).resolves.toHaveLength(4);
    await expect(repo.findByBackingObjectId("workspace-1", "object-2"))
      .resolves.toHaveLength(4);
    await expect(repo.findActiveByWorkspace("workspace-1", {
      asOf: "2026-04-18T01:00:00.000+02:00"
    })).resolves.toEqual([visible]);
  });

  it("rejects noncanonical rows and remains writable after temporal selection", () => {
    const { database, repo: legacyRepo } = createRepo();
    const repo = new SqliteSoftAssociationPathRepo(database);

    expect(() => repo.create(createPathRelationFixture())).toThrow(
      /canonical co-recalled usage profile/u
    );
    markTemporalProjectionSelectedForTest(database);
    expect(() => legacyRepo.create(createPathRelationFixture({ path_id: "legacy-blocked" })))
      .toThrow(/disabled after temporal projection selection/u);
    expect(repo.create(canonicalPath({ path_id: "soft-after-selection" })).path_id)
      .toBe("soft-after-selection");
  });
});

function canonicalPath(overrides: Partial<PathRelation> = {}): PathRelation {
  return createPathRelationFixture({
    anchors: {
      source_anchor: { kind: "object", object_id: "object-1" },
      target_anchor: { kind: "object", object_id: "object-2" }
    },
    constitution: {
      relation_kind: "co_recalled",
      why_this_relation_exists: ["earned co-recall"]
    },
    lifecycle: {
      status: "active",
      retirement_rule: "retire_after_cooldown"
    },
    legitimacy: {
      evidence_basis: ["recalls_edge_co_usage"],
      governance_class: "attention_only"
    },
    ...overrides
  });
}
