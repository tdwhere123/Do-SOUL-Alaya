import { afterEach, describe, expect, it } from "vitest";
import {
  RunMode,
  RunState,
  SynthesisStatus,
  WorkspaceKind,
  WorkspaceState,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../db.js";
import { SqliteRunRepo } from "../../repos/run-repo.js";
import { SqliteSynthesisCapsuleRepo } from "../../repos/synthesis-capsule-repo.js";
import { SqliteWorkspaceRepo } from "../../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createSynthesisCapsule(overrides: Partial<SynthesisCapsule> = {}): SynthesisCapsule {
  return {
    object_id: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
    object_kind: "synthesis_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user",
    topic_key: "tooling/pnpm",
    synthesis_type: "phase_synthesis",
    summary: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1"],
    source_memory_refs: ["memory-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    synthesis_status: SynthesisStatus.WORKING,
    ...overrides
  };
}

describe("SqliteSynthesisCapsuleRepo", () => {
  it("creates and loads a synthesis capsule by id", async () => {
    const { repo } = await createRepo();
    const capsule = createSynthesisCapsule();

    await expect(repo.create(capsule)).resolves.toEqual(capsule);
    await expect(repo.findById(capsule.object_id)).resolves.toEqual(capsule);
  });

  it("lists by topic key", async () => {
    const { repo } = await createRepo();

    await repo.create(createSynthesisCapsule({ object_id: "f714f95c-7dd4-48b1-aeec-7c9cc57f7e66", topic_key: "tooling/pnpm" }));
    await repo.create(createSynthesisCapsule({ object_id: "52f51874-987c-4ddd-a31a-1739cbebf9ab", topic_key: "tooling/pnpm" }));
    await repo.create(createSynthesisCapsule({ object_id: "f34fb57b-c080-4f8d-aa34-6b48a5b81ca2", topic_key: "security/keys" }));

    const rows = await repo.findByTopicKey("workspace-1", "tooling/pnpm");
    expect(rows.map((row) => row.object_id)).toEqual([
      "52f51874-987c-4ddd-a31a-1739cbebf9ab",
      "f714f95c-7dd4-48b1-aeec-7c9cc57f7e66"
    ]);
  });

  it("updates synthesis status", async () => {
    const { repo } = await createRepo();
    const capsule = createSynthesisCapsule();
    await repo.create(capsule);

    const updated = await repo.updateStatus(capsule.object_id, SynthesisStatus.STABLE, "2026-03-21T01:00:00.000Z");

    expect(updated.synthesis_status).toBe(SynthesisStatus.STABLE);
    expect(updated.updated_at).toBe("2026-03-21T01:00:00.000Z");
  });

  it("throws not found when updating status for a missing synthesis capsule", async () => {
    const { repo } = await createRepo();

    await expect(
      repo.updateStatus("missing-synthesis", SynthesisStatus.STABLE, "2026-03-21T01:00:00.000Z")
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("clears a specific evidence ref while preserving the rest", async () => {
    const { repo } = await createRepo();
    const capsule = createSynthesisCapsule({
      evidence_refs: ["evidence-keep", "evidence-drop"]
    });
    await repo.create(capsule);

    const updated = await repo.clearEvidenceRef(
      capsule.object_id,
      "evidence-drop",
      "2026-03-21T02:00:00.000Z"
    );

    expect(updated.evidence_refs).toEqual(["evidence-keep"]);
    expect(updated.updated_at).toBe("2026-03-21T02:00:00.000Z");
  });

  it("clears a specific source memory ref while preserving the rest", async () => {
    const { repo } = await createRepo();
    const capsule = createSynthesisCapsule({
      source_memory_refs: ["memory-keep", "memory-drop"]
    });
    await repo.create(capsule);

    const updated = await repo.clearSourceMemoryRef(
      capsule.object_id,
      "memory-drop",
      "2026-03-21T03:00:00.000Z"
    );

    expect(updated.source_memory_refs).toEqual(["memory-keep"]);
    expect(updated.updated_at).toBe("2026-03-21T03:00:00.000Z");
  });

  it("returns immutable synthesis capsules", async () => {
    const { repo } = await createRepo();
    const created = await repo.create(createSynthesisCapsule());

    expect(() => {
      (created as { summary: string }).summary = "mutated";
    }).toThrow(TypeError);
  });

  // see also: 079-synthesis-capsule-fts-dual.sql — porter + trigram dual lane.
  it("recalls an English synthesis summary via the porter word lane", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createSynthesisCapsule({
        object_id: "1a000000-0000-4000-8000-000000000001",
        summary: "The deployment pipeline rotates the staging credentials nightly."
      })
    );
    await repo.create(
      createSynthesisCapsule({
        object_id: "1a000000-0000-4000-8000-000000000002",
        summary: "An unrelated digest about lunch preferences."
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "deployment credentials", 10);
    expect(hits.map((hit) => hit.object_id)).toContain(
      "1a000000-0000-4000-8000-000000000001"
    );
    expect(hits.map((hit) => hit.object_id)).not.toContain(
      "1a000000-0000-4000-8000-000000000002"
    );
  });

  it("recalls a Chinese synthesis summary via the trigram lane (CJK-blind to porter)", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createSynthesisCapsule({
        object_id: "2a000000-0000-4000-8000-000000000001",
        summary: "用户每天晚上轮换部署流水线的临时凭证。"
      })
    );
    await repo.create(
      createSynthesisCapsule({
        object_id: "2a000000-0000-4000-8000-000000000002",
        summary: "关于午餐偏好的一段无关摘要。"
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "部署流水线", 10);
    expect(hits.map((hit) => hit.object_id)).toContain(
      "2a000000-0000-4000-8000-000000000001"
    );
    expect(hits.map((hit) => hit.object_id)).not.toContain(
      "2a000000-0000-4000-8000-000000000002"
    );
  });

  it("recalls a two-character CJK synthesis word below the trigram boundary", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createSynthesisCapsule({
        object_id: "2a000000-0000-4000-8000-000000000003",
        summary: "The synthesis capsule keeps the short keyword 部署 as a handoff label."
      })
    );

    const hits = await repo.searchByKeyword!("workspace-1", "部署", 10);
    expect(hits.map((hit) => hit.object_id)).toContain(
      "2a000000-0000-4000-8000-000000000003"
    );
  });

  // The searchByKeyword SQL filters `lifecycle_state != 'retired'`. `retired`
  // is not a SynthesisCapsule lifecycle enum value, so the row is written via
  // a direct UPDATE that bypasses the zod-validated repo path — the only way
  // a `retired` row reaches the table — to prove the SQL guard is honored.
  it("excludes a retired synthesis capsule from keyword search", async () => {
    const { repo, database } = await createRepo();
    await repo.create(
      createSynthesisCapsule({
        object_id: "3a000000-0000-4000-8000-000000000001",
        summary: "The deployment pipeline rotates the staging credentials nightly."
      })
    );
    await repo.create(
      createSynthesisCapsule({
        object_id: "3a000000-0000-4000-8000-000000000002",
        summary: "The deployment pipeline rotates the staging credentials nightly."
      })
    );
    database.connection
      .prepare("UPDATE synthesis_capsules SET lifecycle_state = 'retired' WHERE object_id = ?")
      .run("3a000000-0000-4000-8000-000000000001");

    const hits = await repo.searchByKeyword!("workspace-1", "deployment credentials", 10);
    const ids = hits.map((hit) => hit.object_id);
    expect(ids).not.toContain("3a000000-0000-4000-8000-000000000001");
    expect(ids).toContain("3a000000-0000-4000-8000-000000000002");
  });

  // The merged result must keep one comparable rank scale across the porter
  // and trigram lanes; a weak match never outranks a strong one cross-lane.
  it("merges porter and trigram lane ranks for a mixed-script query", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createSynthesisCapsule({
        object_id: "4a000000-0000-4000-8000-000000000001",
        summary: "部署流水线轮换部署流水线的临时凭证，部署流水线全程自动化。"
      })
    );
    await repo.create(
      createSynthesisCapsule({
        object_id: "4a000000-0000-4000-8000-000000000002",
        summary: "这段摘要只在结尾顺带提到部署流水线一次。"
      })
    );
    await repo.create(
      createSynthesisCapsule({
        object_id: "4a000000-0000-4000-8000-000000000003",
        summary: "A long unrelated digest that mentions deployment once in passing."
      })
    );

    const hits = await repo.searchByKeyword!(
      "workspace-1",
      "部署流水线 deployment",
      10
    );
    const ranks = new Map(hits.map((hit) => [hit.object_id, hit.normalized_rank]));
    const strongTrigramRank = ranks.get("4a000000-0000-4000-8000-000000000001")!;
    const weakTrigramRank = ranks.get("4a000000-0000-4000-8000-000000000002")!;
    const porterRank = ranks.get("4a000000-0000-4000-8000-000000000003")!;

    expect(strongTrigramRank).toBeGreaterThan(weakTrigramRank);
    expect(strongTrigramRank).toBeGreaterThanOrEqual(porterRank);
    expect(hits.every((hit) => hit.normalized_rank <= 1)).toBe(true);
  });

  it("returns an empty result for a blank keyword query", async () => {
    const { repo } = await createRepo();
    await repo.create(createSynthesisCapsule());

    await expect(repo.searchByKeyword!("workspace-1", "   ", 10)).resolves.toEqual([]);
  });
});

async function createRepo(): Promise<{
  readonly repo: SqliteSynthesisCapsuleRepo;
  readonly database: ReturnType<typeof initDatabase>;
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

  return {
    repo: new SqliteSynthesisCapsuleRepo(database),
    database
  };
}
