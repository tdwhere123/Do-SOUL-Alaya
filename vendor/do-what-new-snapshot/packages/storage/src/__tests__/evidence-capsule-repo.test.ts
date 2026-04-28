import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceHealthState,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type EvidenceCapsule
} from "@do-what/protocol";
import { initDatabase } from "../db.js";
import { SqliteEvidenceCapsuleRepo } from "../repos/evidence-capsule-repo.js";
import { SqliteRunRepo } from "../repos/run-repo.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

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
      file_path: "packages/core/src/evidence-service.ts",
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
