import { afterEach, describe, expect, it } from "vitest";
import {
  RunMode,
  RunState,
  SynthesisStatus,
  WorkspaceKind,
  WorkspaceState,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteRunRepo } from "../repos/run-repo.js";
import { SqliteSynthesisCapsuleRepo } from "../repos/synthesis-capsule-repo.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

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

  it("returns immutable synthesis capsules", async () => {
    const { repo } = await createRepo();
    const created = await repo.create(createSynthesisCapsule());

    expect(() => {
      (created as { summary: string }).summary = "mutated";
    }).toThrow(TypeError);
  });
});

async function createRepo(): Promise<{
  readonly repo: SqliteSynthesisCapsuleRepo;
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
    repo: new SqliteSynthesisCapsuleRepo(database)
  };
}
