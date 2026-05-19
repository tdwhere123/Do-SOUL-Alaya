import { afterEach, describe, expect, it } from "vitest";
import {
  ClaimLifecycleState,
  WorkspaceKind,
  WorkspaceState,
  canonicalGovernanceSubject,
  type ClaimForm
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteClaimFormRepo } from "../repos/claim-form-repo.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createClaimForm(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user",
    governance_subject: canonicalGovernanceSubject("code_style", { language: "typescript" }),
    claim_kind: "constraint",
    scope_class: "project",
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1"],
    source_object_refs: ["synthesis-1"],
    workspace_id: "workspace-1",
    claim_status: ClaimLifecycleState.DRAFT,
    ...overrides
  };
}

describe("SqliteClaimFormRepo", () => {
  it("creates and loads a claim form by id", async () => {
    const { repo } = await createRepo();
    const claim = createClaimForm();

    expect(repo.create(claim)).toEqual(claim);
    await expect(repo.findById(claim.object_id)).resolves.toEqual(claim);
  });

  it("loads multiple claim forms by id in deterministic order", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createClaimForm({
        object_id: "8af6288f-f460-423f-babc-c9f7c90d733f",
        created_at: "2026-03-21T00:00:01.000Z",
        updated_at: "2026-03-21T00:00:01.000Z"
      })
    );
    await repo.create(
      createClaimForm({
        object_id: "4de58de9-8ec7-45f4-a593-fde6ec67865c",
        created_at: "2026-03-21T00:00:02.000Z",
        updated_at: "2026-03-21T00:00:02.000Z"
      })
    );

    const rows = await repo.findByIds([
      "4de58de9-8ec7-45f4-a593-fde6ec67865c",
      "8af6288f-f460-423f-babc-c9f7c90d733f",
      "4de58de9-8ec7-45f4-a593-fde6ec67865c",
      "missing-claim"
    ]);

    expect(rows.map((row) => row.object_id)).toEqual([
      "8af6288f-f460-423f-babc-c9f7c90d733f",
      "4de58de9-8ec7-45f4-a593-fde6ec67865c"
    ]);
  });

  it("lists by canonical key", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createClaimForm({
        object_id: "8af6288f-f460-423f-babc-c9f7c90d733f",
        governance_subject: canonicalGovernanceSubject("code_style", { language: "typescript" })
      })
    );
    await repo.create(
      createClaimForm({
        object_id: "4de58de9-8ec7-45f4-a593-fde6ec67865c",
        governance_subject: canonicalGovernanceSubject("code_style", { language: "typescript" })
      })
    );
    await repo.create(
      createClaimForm({
        object_id: "5ef7d533-0a03-4daa-ae12-4acc76253b92",
        governance_subject: canonicalGovernanceSubject("security", { category: "secrets" })
      })
    );

    const rows = await repo.findByCanonicalKey("workspace-1", "code_style::language=typescript");
    expect(rows.map((row) => row.object_id)).toEqual([
      "4de58de9-8ec7-45f4-a593-fde6ec67865c",
      "8af6288f-f460-423f-babc-c9f7c90d733f"
    ]);
  });

  it("lists by claim status", async () => {
    const { repo } = await createRepo();

    await repo.create(createClaimForm({ object_id: "8f9f0d2a-10f6-4b5d-ab5f-ef36f0d85013", claim_status: ClaimLifecycleState.DRAFT }));
    await repo.create(createClaimForm({ object_id: "5fe8448e-57d7-40f2-9f0d-3dd8d57f6f80", claim_status: ClaimLifecycleState.ACTIVE }));

    const rows = await repo.findByStatus("workspace-1", ClaimLifecycleState.ACTIVE);
    expect(rows.map((row) => row.object_id)).toEqual(["5fe8448e-57d7-40f2-9f0d-3dd8d57f6f80"]);
  });

  it("updates claim lifecycle status", async () => {
    const { repo } = await createRepo();
    const claim = createClaimForm();
    await repo.create(claim);

    const updated = await repo.updateStatus(
      claim.object_id,
      ClaimLifecycleState.ACTIVE,
      "2026-03-21T01:00:00.000Z",
      claim.claim_status
    );

    expect(updated.claim_status).toBe(ClaimLifecycleState.ACTIVE);
    expect(updated.updated_at).toBe("2026-03-21T01:00:00.000Z");
  });

  it("updates claim lifecycle status through the sync CAS path", async () => {
    const { repo } = await createRepo();
    const claim = createClaimForm();
    await repo.create(claim);

    const updated = repo.updateStatusSync(
      claim.object_id,
      ClaimLifecycleState.ACTIVE,
      "2026-03-21T01:00:00.000Z",
      claim.claim_status
    );

    expect(updated.claim_status).toBe(ClaimLifecycleState.ACTIVE);
    expect(updated.updated_at).toBe("2026-03-21T01:00:00.000Z");
  });

  it("throws not found when updating status for a missing claim", async () => {
    const { repo } = await createRepo();

    await expect(
      repo.updateStatus(
        "missing-claim",
        ClaimLifecycleState.ACTIVE,
        "2026-03-21T01:00:00.000Z",
        ClaimLifecycleState.DRAFT
      )
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  // invariant: optimistic-concurrency guard. Two concurrent transitions
  // racing from the same starting state cannot both win. The first
  // writer flips the status, the second writer's UPDATE finds zero
  // matching rows and the storage layer raises QUERY_FAILED rather
  // than silently overwriting.
  it("raises conflict when expectedFromStatus does not match the current claim_status", async () => {
    const { repo } = await createRepo();
    const claim = createClaimForm();
    await repo.create(claim);
    await repo.updateStatus(
      claim.object_id,
      ClaimLifecycleState.ACTIVE,
      "2026-03-21T01:00:00.000Z",
      claim.claim_status
    );

    await expect(
      repo.updateStatus(
        claim.object_id,
        ClaimLifecycleState.ARCHIVED,
        "2026-03-21T02:00:00.000Z",
        ClaimLifecycleState.DRAFT
      )
    ).rejects.toMatchObject({
      code: "QUERY_FAILED"
    });
  });

  it("returns immutable claim forms", async () => {
    const { repo } = await createRepo();
    const created = await repo.create(createClaimForm());

    expect(() => {
      (created as { proposition_digest: string }).proposition_digest = "mutated";
    }).toThrow(TypeError);
  });
});

async function createRepo(): Promise<{
  readonly repo: SqliteClaimFormRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });

  return {
    repo: new SqliteClaimFormRepo(database)
  };
}
