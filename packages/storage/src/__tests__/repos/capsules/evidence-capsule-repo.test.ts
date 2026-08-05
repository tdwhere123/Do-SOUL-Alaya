import { afterEach, describe, expect, it } from "vitest";
import { expectFrozenPropertyWriteThrows } from "../../support/frozen-mutation.js";
import { EvidenceHealthState } from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import {
  createEvidenceCapsule,
  createEvidenceCapsuleRepo as createRepo,
  evidenceCapsuleDatabases as databases
} from "./evidence-capsule-repo-fixture.js";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteEvidenceCapsuleRepo", () => {
  it("creates and loads an evidence capsule by id with anchor JSON round-trip", async () => {
    const { repo } = await createRepo();
    const capsule = createEvidenceCapsule();

    await expect(repo.create(capsule)).resolves.toEqual(capsule);
    await expect(repo.findById(capsule.object_id)).resolves.toEqual(capsule);
  });

  it("loads evidence capsules by ids in a batch", async () => {
    const { repo } = await createRepo();

    await repo.create(createEvidenceCapsule({ object_id: "f6c1b587-be07-4410-b2ca-8bfbc4d82db4" }));
    await repo.create(createEvidenceCapsule({ object_id: "3ca5f78f-b5fd-4543-99eb-ce72ab2578ab" }));
    await repo.create(createEvidenceCapsule({ object_id: "256a7ff5-6150-4a82-9a53-99dbfd08cb77" }));

    const rows = await repo.findByIds("workspace-1", [
      "256a7ff5-6150-4a82-9a53-99dbfd08cb77",
      "missing-id",
      "3ca5f78f-b5fd-4543-99eb-ce72ab2578ab",
      "3ca5f78f-b5fd-4543-99eb-ce72ab2578ab"
    ]);

    expect(rows.map((row) => row.object_id)).toEqual([
      "256a7ff5-6150-4a82-9a53-99dbfd08cb77",
      "3ca5f78f-b5fd-4543-99eb-ce72ab2578ab"
    ]);
  });

  it("loads evidence capsules by ids only inside the requested workspace", async () => {
    const { repo } = await createRepo();

    const sharedId = "f6c1b587-be07-4410-b2ca-8bfbc4d82db4";
    await repo.create(createEvidenceCapsule({ object_id: sharedId, run_id: "run-3", workspace_id: "workspace-2" }));

    const rows = await repo.findByIds("workspace-1", [sharedId]);

    expect(rows).toEqual([]);
  });

  it("queries source anchors by ids while safely ignoring invalid JSON shapes", async () => {
    const { database, repo } = await createRepo();
    await repo.create(createEvidenceCapsule({
      object_id: "f6c1b587-be07-4410-b2ca-8bfbc4d82db4",
      physical_anchor: { file_path: null, line_range: null, symbol_name: null, artifact_ref: "Doc-S1-T10" }
    }));
    const malformedId = "3ca5f78f-b5fd-4543-99eb-ce72ab2578ab";
    const nullId = "357d80f9-26f1-4a27-97ea-ae8f7729caa1";
    const nonTextId = "9fa00d38-516b-47b5-a120-713ae5eb085d";
    const blankId = "4820c456-17cd-4abc-9c70-51fc0469431b";
    for (const objectId of [malformedId, nullId, nonTextId, blankId]) {
      await repo.create(createEvidenceCapsule({ object_id: objectId }));
    }
    await repo.create(createEvidenceCapsule({
      object_id: "256a7ff5-6150-4a82-9a53-99dbfd08cb77",
      run_id: "run-3",
      workspace_id: "workspace-2",
      physical_anchor: { file_path: null, line_range: null, symbol_name: null, artifact_ref: "doc-s1-t11" }
    }));

    const updateAnchor = database.connection.prepare(
      "UPDATE evidence_capsules SET physical_anchor = ? WHERE object_id = ?"
    );
    updateAnchor.run("not-json", malformedId);
    updateAnchor.run("null", nullId);
    updateAnchor.run(JSON.stringify({ artifact_ref: 42 }), nonTextId);
    updateAnchor.run(JSON.stringify({ artifact_ref: "   " }), blankId);

    await expect(repo.findSourceAnchorsByIds("workspace-1", [
      "f6c1b587-be07-4410-b2ca-8bfbc4d82db4",
      "256a7ff5-6150-4a82-9a53-99dbfd08cb77",
      malformedId,
      nullId,
      nonTextId,
      blankId
    ])).resolves.toEqual([
      { evidence_object_id: "f6c1b587-be07-4410-b2ca-8bfbc4d82db4", artifact_ref: "Doc-S1-T10" }
    ]);
  });

  it("finds a workspace-scoped evidence capsule by artifact reference", async () => {
    const { repo } = await createRepo();
    const target = createEvidenceCapsule({
      object_id: "f6c1b587-be07-4410-b2ca-8bfbc4d82db4",
      physical_anchor: {
        file_path: null,
        line_range: null,
        symbol_name: null,
        artifact_ref: "alaya:garden-turn-evidence:signal-1"
      }
    });
    await repo.create(target);
    await repo.create(createEvidenceCapsule({
      object_id: "256a7ff5-6150-4a82-9a53-99dbfd08cb77",
      workspace_id: "workspace-2",
      run_id: "run-2",
      physical_anchor: target.physical_anchor
    }));

    await expect(repo.findByArtifactRef("workspace-1", "alaya:garden-turn-evidence:signal-1"))
      .resolves.toEqual(target);
    await expect(repo.findByArtifactRef("workspace-3", "alaya:garden-turn-evidence:signal-1"))
      .resolves.toBeNull();
  });

  it("chunks source-anchor id batches above SQLite's variable limit", async () => {
    const { repo } = await createRepo();
    const ids = Array.from({ length: 1_005 }, (_, index) =>
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
    );
    for (const [index, objectId] of ids.entries()) {
      await repo.create(createEvidenceCapsule({
        object_id: objectId,
        physical_anchor: {
          file_path: null,
          line_range: null,
          symbol_name: null,
          artifact_ref: `bulk-s1-t${index}`
        }
      }));
    }

    const rows = await repo.findSourceAnchorsByIds("workspace-1", ids);

    expect(rows).toHaveLength(ids.length);
    expect(rows[0]).toEqual({ evidence_object_id: ids[0], artifact_ref: "bulk-s1-t0" });
    expect(rows.at(-1)).toEqual({
      evidence_object_id: ids.at(-1),
      artifact_ref: "bulk-s1-t1004"
    });
  });

  it("lists by run id", async () => {
    const { repo } = await createRepo();

    await repo.create(createEvidenceCapsule({ object_id: "f6c1b587-be07-4410-b2ca-8bfbc4d82db4", run_id: "run-1" }));
    await repo.create(createEvidenceCapsule({ object_id: "3ca5f78f-b5fd-4543-99eb-ce72ab2578ab", run_id: "run-1" }));
    await repo.create(createEvidenceCapsule({ object_id: "256a7ff5-6150-4a82-9a53-99dbfd08cb77", run_id: "run-2" }));

    const rows = await repo.findByRunId("run-1");
    expect(rows.map((row) => row.object_id)).toEqual([
      "3ca5f78f-b5fd-4543-99eb-ce72ab2578ab",
      "f6c1b587-be07-4410-b2ca-8bfbc4d82db4"
    ]);
    await expect(repo.findByRunIdPage?.("run-1", { limit: 1, offset: 1 })).resolves.toMatchObject([
      { object_id: "f6c1b587-be07-4410-b2ca-8bfbc4d82db4" }
    ]);
  });

  it("lists by workspace id", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createEvidenceCapsule({
        object_id: "fc8f9786-5ec4-4d98-a630-7350dde255f8",
        run_id: "run-1",
        workspace_id: "workspace-1"
      })
    );
    await repo.create(
      createEvidenceCapsule({
        object_id: "bd4db628-a17a-44a7-9000-e95f4ea61fd3",
        run_id: "run-2",
        workspace_id: "workspace-1"
      })
    );
    await repo.create(
      createEvidenceCapsule({
        object_id: "73ced4de-ff1d-460d-9538-fda59ca4fe84",
        run_id: "run-3",
        workspace_id: "workspace-2"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1");
    expect(rows.map((row) => row.object_id)).toEqual([
      "bd4db628-a17a-44a7-9000-e95f4ea61fd3",
      "fc8f9786-5ec4-4d98-a630-7350dde255f8"
    ]);
    await expect(repo.findByWorkspaceIdPage?.("workspace-1", { limit: 1, offset: 0 })).resolves.toMatchObject([
      { object_id: "bd4db628-a17a-44a7-9000-e95f4ea61fd3" }
    ]);
  });

  it("lists by health state", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createEvidenceCapsule({
        object_id: "48f928be-f3c2-4850-ad0f-c744870606cb",
        evidence_health_state: EvidenceHealthState.VERIFIED
      })
    );
    await repo.create(
      createEvidenceCapsule({
        object_id: "67637f89-3086-4c6d-9e52-24545ca7cc9f",
        evidence_health_state: EvidenceHealthState.DEGRADED
      })
    );

    const rows = await repo.findByHealth(EvidenceHealthState.DEGRADED);
    expect(rows.map((row) => row.object_id)).toEqual(["67637f89-3086-4c6d-9e52-24545ca7cc9f"]);
    await expect(
      repo.findByHealthPage?.(EvidenceHealthState.DEGRADED, { limit: 1, offset: 0 })
    ).resolves.toMatchObject([{ object_id: "67637f89-3086-4c6d-9e52-24545ca7cc9f" }]);
  });

  it("updates health and updated_at", async () => {
    const { repo } = await createRepo();
    const capsule = createEvidenceCapsule();
    await repo.create(capsule);

    const updated = await repo.updateHealth(
      capsule.object_id,
      EvidenceHealthState.BROKEN,
      "2026-03-20T03:00:00.000Z"
    );

    expect(updated.evidence_health_state).toBe(EvidenceHealthState.BROKEN);
    expect(updated.updated_at).toBe("2026-03-20T03:00:00.000Z");

    const loaded = await repo.findById(capsule.object_id);
    expect(loaded?.evidence_health_state).toBe(EvidenceHealthState.BROKEN);
    expect(loaded?.updated_at).toBe("2026-03-20T03:00:00.000Z");
  });

  it("returns immutable capsules", async () => {
    const { repo } = await createRepo();
    const created = await repo.create(createEvidenceCapsule());

    expectFrozenPropertyWriteThrows(created, "gist", "mutated");
  });

  it("recalls English evidence corpus via the porter word lane", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createEvidenceCapsule({
        object_id: "1f5c2a90-0000-4000-8000-000000000001",
        gist: "The deployment pipeline rotates the staging credentials nightly.",
        excerpt: "staging credentials rotate nightly"
      })
    );
    await repo.create(
      createEvidenceCapsule({
        object_id: "1f5c2a90-0000-4000-8000-000000000002",
        gist: "An unrelated note about lunch preferences.",
        excerpt: "lunch preferences"
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "deployment credentials", 10);
    expect(hits.map((hit) => hit.object_id)).toContain("1f5c2a90-0000-4000-8000-000000000001");
    expect(hits.map((hit) => hit.object_id)).not.toContain("1f5c2a90-0000-4000-8000-000000000002");
  });

  it("exposes source-qualified raw evidence lane observations", async () => {
    const { repo } = await createRepo();
    await repo.create(createEvidenceCapsule({
      object_id: "1f5c2a90-0000-4000-8000-000000000021",
      gist: "The deployment pipeline rotates staging credentials.",
      excerpt: "staging credentials"
    }));

    const field = await repo.searchByKeywordField!(
      "workspace-1",
      "deployment credentials",
      10
    );
    const porter = field.lanes.find((lane) => lane.lane === "porter");

    expect(porter?.status).toBe("complete");
    expect(porter?.observations.some((observation) =>
      observation.source_id.startsWith("owner:")
    )).toBe(true);
    expect(field.lanes.find((lane) => lane.lane === "exact")?.status).toBe("ineligible");
    expect(field.matches).toEqual(await repo.searchByKeyword!(
      "workspace-1",
      "deployment credentials",
      10
    ));
    const batch = await repo.searchManyByKeywordField!("workspace-1", [
      { queryText: "deployment credentials", limit: 10 },
      { queryText: "missing phrase", limit: 10 }
    ]);
    expect(batch).toEqual([
      field,
      expect.objectContaining({ matches: [] })
    ]);
  });

  it("materializes evidence refinement levels from one transaction-bound row set", async () => {
    const { repo } = await createRepo();
    for (const [index, objectId] of [
      "1f5c2a90-0000-4000-8000-000000000031",
      "1f5c2a90-0000-4000-8000-000000000032"
    ].entries()) {
      await repo.create(createEvidenceCapsule({
        object_id: objectId,
        gist: "Identical evidence refinement witness.",
        excerpt: "Identical evidence refinement witness.",
        source_hash: `sha256:evidence-refinement-${index}`
      }));
    }

    const field = await repo.searchByKeywordField!(
      "workspace-1", "identical", 1, [2]
    );
    const basePorter = field.lanes.find(({ lane }) => lane === "porter")!;
    const deeper = field.refinement_levels?.[0];
    const deepPorter = deeper?.lanes.find(({ lane }) => lane === "porter");

    expect(field.matches).toHaveLength(1);
    expect(deeper?.matches).toHaveLength(2);
    expect(deepPorter?.observations.slice(0, 1).map(({ source_id }) => source_id))
      .toEqual(basePorter.observations.map(({ source_id }) => source_id));
    expect(basePorter.observations[0]?.normalized_rank).toBe(1);
    expect(deepPorter?.observations[0]?.normalized_rank).toBe(0.75);
  });

  it("maps invalid evidence refinement depths to a validation storage error", async () => {
    const { repo } = await createRepo();

    await expect(repo.searchByKeywordField!("workspace-1", "identical", 1, [1]))
      .rejects.toMatchObject({
        name: "StorageError",
        code: "VALIDATION_FAILED"
      } satisfies Partial<StorageError>);
  });

  it("recalls atomic User search children and collapses them to their evidence owner", async () => {
    const { database, repo } = await createRepo();
    const objectId = "1f5c2a90-0000-4000-8000-000000000010";
    await repo.create(
      createEvidenceCapsule({
        object_id: objectId,
        gist: "receipt owner",
        excerpt: "A broad trusted User turn.",
        source_hash: "sha256:garden-source-turn-fallback-v2:abc"
      }),
      [
        {
          projection_id: 1,
          projection_kind: "user_assertion",
          content: "I bought my bookshelf from IKEA."
        },
        {
          projection_id: 2,
          projection_kind: "user_assertion",
          content: "I named my playlist Summer Vibes."
        }
      ]
    );

    const hits = await repo.searchByKeyword!("workspace-1", "bookshelf IKEA", 10);
    expect(hits.filter((hit) => hit.object_id === objectId)).toHaveLength(1);

    database.connection.prepare(
      "UPDATE evidence_capsules SET source_hash = ? WHERE object_id = ?"
    ).run("sha256:garden-source-turn-fallback-v2:changed", objectId);
    await expect(repo.searchByKeyword!("workspace-1", "bookshelf IKEA", 10))
      .resolves.not.toEqual(expect.arrayContaining([
        expect.objectContaining({ object_id: objectId })
      ]));

    await repo.deleteById(objectId);
    await expect(repo.searchByKeyword!("workspace-1", "bookshelf IKEA", 10))
      .resolves.not.toEqual(expect.arrayContaining([
        expect.objectContaining({ object_id: objectId })
      ]));
  });

  it("indexes gist corpus when excerpt is a narrow distilled fact", async () => {
    const { repo } = await createRepo();
    const objectId = "1f5c2a90-0000-4000-8000-000000000003";
    await repo.create(
      createEvidenceCapsule({
        object_id: objectId,
        gist: "User: I bought my bookshelf from IKEA. The patio table is weatherproof cedar.",
        excerpt: "I bought my bookshelf from IKEA."
      })
    );

    await expect(repo.searchByKeyword!("workspace-1", "bookshelf IKEA", 10))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ object_id: objectId })]));
    await expect(repo.searchByKeyword!("workspace-1", "weatherproof cedar", 10))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ object_id: objectId })]));
  });

  it("recalls Chinese evidence corpus via the trigram lane (previously CJK-blind)", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createEvidenceCapsule({
        object_id: "2f5c2a90-0000-4000-8000-000000000001",
        gist: "用户每天晚上轮换部署流水线的临时凭证。",
        excerpt: "轮换部署流水线凭证"
      })
    );
    await repo.create(
      createEvidenceCapsule({
        object_id: "2f5c2a90-0000-4000-8000-000000000002",
        gist: "关于午餐偏好的一段无关记录。",
        excerpt: "午餐偏好"
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "部署流水线", 10);
    expect(hits).toContainEqual(expect.objectContaining({
      object_id: "2f5c2a90-0000-4000-8000-000000000001",
      matched_fts_lanes: ["trigram"]
    }));
    expect(hits.map((hit) => hit.object_id)).not.toContain("2f5c2a90-0000-4000-8000-000000000002");
  });

  it("recalls a two-character CJK evidence word below the trigram boundary", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createEvidenceCapsule({
        object_id: "2f5c2a90-0000-4000-8000-000000000003",
        gist: "The release note labels the handoff keyword as 部署 before approval.",
        excerpt: "handoff keyword 部署"
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "部署", 10);
    expect(hits).toContainEqual(expect.objectContaining({
      object_id: "2f5c2a90-0000-4000-8000-000000000003",
      matched_fts_lanes: ["porter"]
    }));
  });

  it("recalls mixed-script evidence corpus by fanning out to both lanes", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createEvidenceCapsule({
        object_id: "3f5c2a90-0000-4000-8000-000000000001",
        gist: "The 部署流水线 pipeline rotates 凭证 every night.",
        excerpt: "pipeline rotates 凭证"
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "pipeline 部署流水线", 10);
    expect(hits).toContainEqual(expect.objectContaining({
      object_id: "3f5c2a90-0000-4000-8000-000000000001",
      matched_fts_lanes: ["porter", "trigram"]
    }));
  });

  it("ranks a strong match above a weak one across lanes", async () => {
    const { repo } = await createRepo();
    // Trigram lane: a strong full-phrase match plus a weaker partial match, so
    // the lane has multiple hits and a wide bm25 span.
    await repo.create(
      createEvidenceCapsule({
        object_id: "4f5c2a90-0000-4000-8000-000000000001",
        gist: "部署流水线轮换部署流水线的临时凭证，部署流水线全程自动化。",
        excerpt: "部署流水线自动化"
      })
    );
    await repo.create(
      createEvidenceCapsule({
        object_id: "4f5c2a90-0000-4000-8000-000000000002",
        gist: "这段记录只在结尾顺带提到部署流水线一次。",
        excerpt: "顺带提到部署流水线"
      })
    );
    // Porter lane: a single mediocre hit. Under per-lane min-max this single
    // hit pinned to 1.0 and could thereby beat the trigram lane's genuine
    // weaker rows. Ordinal scoring keeps it comparable across lanes.
    await repo.create(
      createEvidenceCapsule({
        object_id: "4f5c2a90-0000-4000-8000-000000000003",
        gist: "A long unrelated note that mentions deployment once in passing.",
        excerpt: "mentions deployment once"
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "部署流水线 deployment", 10);
    const ranks = new Map(hits.map((hit) => [hit.object_id, hit.normalized_rank]));

    const strongTrigramRank = ranks.get("4f5c2a90-0000-4000-8000-000000000001")!;
    const weakTrigramRank = ranks.get("4f5c2a90-0000-4000-8000-000000000002")!;
    const porterRank = ranks.get("4f5c2a90-0000-4000-8000-000000000003")!;

    // The strong full-phrase match is the top of its lane; the weak partial
    // match scores strictly lower in the same lane.
    expect(strongTrigramRank).toBeGreaterThan(weakTrigramRank);
    // Cross-lane soundness: the single mediocre porter hit must never outrank
    // the genuine strong trigram match. Under the old per-lane min-max it did
    // (the lone porter hit pinned to 1.0 while the strong trigram hit, sharing
    // a wide span, could land below it).
    expect(strongTrigramRank).toBeGreaterThanOrEqual(porterRank);
    // The weak trigram match must rank below the lone porter hit's score is
    // not asserted here (lane-relative); the load-bearing guarantee is that a
    // weak match never beats a strong one across lanes.
    expect(weakTrigramRank).toBeLessThan(strongTrigramRank);
  });

  it("breaks an exact cross-lane score tie by lane priority, not object_id", async () => {
    const { repo } = await createRepo();
    // A porter-lane top hit and a trigram-lane top hit both score 1.0 (each is
    // the best of its lane). The tie must resolve toward the porter lane, not
    // toward whichever object_id sorts first lexically. The trigram capsule is
    // given the lexically-smaller id so an object_id tiebreak would wrongly
    // surface it first.
    await repo.create(
      createEvidenceCapsule({
        object_id: "0a000000-0000-4000-8000-000000000001",
        gist: "部署流水线",
        excerpt: "部署流水线"
      })
    );
    await repo.create(
      createEvidenceCapsule({
        object_id: "f0000000-0000-4000-8000-000000000001",
        gist: "deployment pipeline",
        excerpt: "deployment pipeline"
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "部署流水线 deployment", 10);
    expect(hits[0]?.object_id).toBe("f0000000-0000-4000-8000-000000000001");
    expect(hits[0]?.normalized_rank).toBe(1);
  });
});
