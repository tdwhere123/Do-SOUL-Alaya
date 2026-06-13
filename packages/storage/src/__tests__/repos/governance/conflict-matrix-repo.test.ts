import { afterEach, describe, expect, it } from "vitest";
import {
  ClaimKind,
  ClaimLifecycleState,
  ScopeClass,
  WorkspaceKind,
  WorkspaceState,
  canonicalGovernanceSubject,
  type ClaimForm,
  type ConflictMatrixEdge
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteClaimFormRepo } from "../../../repos/governance/claim-form-repo.js";
import { SqliteConflictMatrixRepo } from "../../../repos/governance/conflict-matrix-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

const WORKSPACE_ID = "workspace-1";
const EDGE_ID_1 = "11111111-1111-4111-8111-111111111111";
const EDGE_ID_2 = "22222222-2222-4222-8222-222222222222";
const CLAIM_ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createClaim(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: CLAIM_ID_1,
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    governance_subject: canonicalGovernanceSubject("security", { category: "secrets" }),
    claim_kind: ClaimKind.CONSTRAINT,
    scope_class: ScopeClass.PROJECT,
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Never print secrets.",
    evidence_refs: [],
    source_object_refs: [],
    workspace_id: WORKSPACE_ID,
    claim_status: ClaimLifecycleState.ACTIVE,
    ...overrides
  };
}

function createEdge(overrides: Partial<ConflictMatrixEdge> = {}): ConflictMatrixEdge {
  return {
    object_id: EDGE_ID_1,
    object_kind: "conflict_matrix_edge",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T01:00:00.000Z",
    updated_at: "2026-03-21T01:00:00.000Z",
    created_by: "user_action",
    source_claim_id: CLAIM_ID_1,
    target_claim_id: CLAIM_ID_2,
    edge_type: "incompatible_with",
    workspace_id: WORKSPACE_ID,
    ...overrides
  };
}

describe("SqliteConflictMatrixRepo", () => {
  it("applies migration 011 and creates conflict_matrix_edges table", async () => {
    const { database } = await createRepo();

    const migration = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 11 LIMIT 1")
      .get() as { readonly version: number } | undefined;

    expect(migration?.version).toBe(11);
  });

  it("creates and finds an edge by id", async () => {
    const { repo } = await createRepo();
    const edge = createEdge();

    await expect(repo.create(edge)).resolves.toEqual(edge);
    await expect(repo.findById(edge.object_id)).resolves.toEqual(edge);
  });

  it("enforces source-target-edge_type uniqueness", async () => {
    const { repo } = await createRepo();

    await repo.create(createEdge({ object_id: EDGE_ID_1 }));

    await expect(
      repo.create(
        createEdge({
          object_id: EDGE_ID_2
        })
      )
    ).rejects.toMatchObject({
      code: "QUERY_FAILED"
    });
  });

  it("finds edges between claims in both directions", async () => {
    const { repo } = await createRepo();

    await repo.create(createEdge({ object_id: EDGE_ID_1, edge_type: "exception_to" }));
    await repo.create(
      createEdge({
        object_id: EDGE_ID_2,
        source_claim_id: CLAIM_ID_2,
        target_claim_id: CLAIM_ID_1,
        edge_type: "supports"
      })
    );

    const found = await repo.findBetweenClaims(CLAIM_ID_1, CLAIM_ID_2);

    expect(found).toHaveLength(2);
    expect(found.map((edge) => edge.object_id)).toEqual([EDGE_ID_1, EDGE_ID_2]);
  });

  it("deletes an edge by id", async () => {
    const { repo } = await createRepo();

    await repo.create(createEdge({ object_id: EDGE_ID_1 }));
    await repo.delete(EDGE_ID_1);

    await expect(repo.findById(EDGE_ID_1)).resolves.toBeNull();
  });

  it("cascades edge deletion when source claim is deleted", async () => {
    const { database, repo } = await createRepo();

    await repo.create(createEdge({ object_id: EDGE_ID_1 }));

    database.connection.prepare("DELETE FROM claim_forms WHERE object_id = ?").run(CLAIM_ID_1);

    await expect(repo.findById(EDGE_ID_1)).resolves.toBeNull();
  });
});

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteConflictMatrixRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const claimRepo = new SqliteClaimFormRepo(database);

  await workspaceRepo.create({
    workspace_id: WORKSPACE_ID,
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });

  await claimRepo.create(createClaim({ object_id: CLAIM_ID_1 }));
  await claimRepo.create(
    createClaim({
      object_id: CLAIM_ID_2,
      governance_subject: canonicalGovernanceSubject("security", { category: "http" }),
      proposition_digest: "Allow HTTP in local dev."
    })
  );

  return {
    database,
    repo: new SqliteConflictMatrixRepo(database)
  };
}
