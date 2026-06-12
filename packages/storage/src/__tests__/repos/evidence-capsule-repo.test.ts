import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceHealthState,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../sqlite/db.js";
import { SqliteEvidenceCapsuleRepo } from "../../repos/capsules/evidence-capsule-repo.js";
import { SqliteRunRepo } from "../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../repos/runtime/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createEvidenceCapsule(overrides: Partial<EvidenceCapsule> = {}): EvidenceCapsule {
  return {
    object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "user",
    evidence_kind: "tool_output",
    semantic_anchor: {
      topic: "build output",
      keywords: ["pnpm", "build"],
      summary: "Build output from CI"
    },
    event_anchor: {
      event_type: "engine.response.received",
      event_id: "evt_1",
      occurred_at: "2026-03-20T00:00:00.000Z"
    },
    physical_anchor: {
      file_path: "packages/core/src/memory/evidence-service.ts",
      line_range: { start: 1, end: 120 },
      symbol_name: "EvidenceService",
      artifact_ref: "artifact://evidence/1"
    },
    evidence_health_state: "verified",
    gist: "Evidence gist",
    excerpt: "Detailed evidence excerpt",
    source_hash: "sha256:abc",
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null,
    ...overrides
  };
}

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

    const rows = await repo.findByIds([
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

    expect(() => {
      (created as any).gist = "mutated";
    }).toThrow(TypeError);
  });

  it("recalls an English evidence excerpt via the porter word lane", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createEvidenceCapsule({
        object_id: "1f5c2a90-0000-4000-8000-000000000001",
        gist: "build gist",
        excerpt: "The deployment pipeline rotates the staging credentials nightly."
      })
    );
    await repo.create(
      createEvidenceCapsule({
        object_id: "1f5c2a90-0000-4000-8000-000000000002",
        gist: "other gist",
        excerpt: "An unrelated note about lunch preferences."
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "deployment credentials", 10);
    expect(hits.map((hit) => hit.object_id)).toContain("1f5c2a90-0000-4000-8000-000000000001");
    expect(hits.map((hit) => hit.object_id)).not.toContain("1f5c2a90-0000-4000-8000-000000000002");
  });

  it("recalls a Chinese evidence excerpt via the trigram lane (previously CJK-blind)", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createEvidenceCapsule({
        object_id: "2f5c2a90-0000-4000-8000-000000000001",
        gist: "中文摘要",
        excerpt: "用户每天晚上轮换部署流水线的临时凭证。"
      })
    );
    await repo.create(
      createEvidenceCapsule({
        object_id: "2f5c2a90-0000-4000-8000-000000000002",
        gist: "无关摘要",
        excerpt: "关于午餐偏好的一段无关记录。"
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "部署流水线", 10);
    expect(hits.map((hit) => hit.object_id)).toContain("2f5c2a90-0000-4000-8000-000000000001");
    expect(hits.map((hit) => hit.object_id)).not.toContain("2f5c2a90-0000-4000-8000-000000000002");
  });

  it("recalls a two-character CJK evidence word below the trigram boundary", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createEvidenceCapsule({
        object_id: "2f5c2a90-0000-4000-8000-000000000003",
        gist: "短词摘要",
        excerpt: "The release note labels the handoff keyword as 部署 before approval."
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "部署", 10);
    expect(hits.map((hit) => hit.object_id)).toContain("2f5c2a90-0000-4000-8000-000000000003");
  });

  it("recalls a mixed-script evidence excerpt by fanning out to both lanes", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createEvidenceCapsule({
        object_id: "3f5c2a90-0000-4000-8000-000000000001",
        gist: "mixed gist",
        excerpt: "The 部署 pipeline rotates 凭证 every night."
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "pipeline 凭证", 10);
    expect(hits.map((hit) => hit.object_id)).toContain("3f5c2a90-0000-4000-8000-000000000001");
  });

  it("ranks a strong match above a weak one across lanes", async () => {
    const { repo } = await createRepo();
    // Trigram lane: a strong full-phrase match plus a weaker partial match, so
    // the lane has multiple hits and a wide bm25 span.
    await repo.create(
      createEvidenceCapsule({
        object_id: "4f5c2a90-0000-4000-8000-000000000001",
        gist: "中文摘要",
        excerpt: "部署流水线轮换部署流水线的临时凭证，部署流水线全程自动化。"
      })
    );
    await repo.create(
      createEvidenceCapsule({
        object_id: "4f5c2a90-0000-4000-8000-000000000002",
        gist: "弱匹配",
        excerpt: "这段记录只在结尾顺带提到部署流水线一次。"
      })
    );
    // Porter lane: a single mediocre hit. Under per-lane min-max this single
    // hit pinned to 1.0 and could thereby beat the trigram lane's genuine
    // weaker rows. Ordinal scoring keeps it comparable across lanes.
    await repo.create(
      createEvidenceCapsule({
        object_id: "4f5c2a90-0000-4000-8000-000000000003",
        gist: "porter weak",
        excerpt: "A long unrelated note that mentions deployment once in passing."
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
        gist: "trigram top",
        excerpt: "部署流水线"
      })
    );
    await repo.create(
      createEvidenceCapsule({
        object_id: "f0000000-0000-4000-8000-000000000001",
        gist: "porter top",
        excerpt: "deployment pipeline"
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "部署流水线 deployment", 10);
    expect(hits[0]?.object_id).toBe("f0000000-0000-4000-8000-000000000001");
    expect(hits[0]?.normalized_rank).toBe(1);
  });
});

async function createRepo(): Promise<{
  readonly repo: SqliteEvidenceCapsuleRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await workspaceRepo.create({
    workspace_id: "workspace-2",
    name: "workspace two",
    root_path: "/tmp/ws2",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });

  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await runRepo.create({
    run_id: "run-2",
    workspace_id: "workspace-1",
    title: "run two",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await runRepo.create({
    run_id: "run-3",
    workspace_id: "workspace-2",
    title: "run three",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return {
    repo: new SqliteEvidenceCapsuleRepo(database)
  };
}
