import { afterEach, describe, expect, it } from "vitest";
import {
  ClaimKind,
  ScopeClass,
  WorkspaceKind,
  WorkspaceState,
  canonicalGovernanceSubject,
  type Slot
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../sqlite/db.js";
import { SqliteSlotRepo } from "../../repos/slot-repo.js";
import { SqliteWorkspaceRepo } from "../../repos/runtime/workspace-repo.js";

const SLOT_ID_1 = "11111111-1111-4111-8111-111111111111";
const SLOT_ID_2 = "22222222-2222-4222-8222-222222222222";
const CLAIM_ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    object_id: SLOT_ID_1,
    object_kind: "slot",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "system",
    governance_subject: canonicalGovernanceSubject("security", { category: "secrets" }),
    claim_kind: ClaimKind.CONSTRAINT,
    scope_class: ScopeClass.PROJECT,
    winner_claim_id: CLAIM_ID_1,
    incumbent_since: "2026-03-21T00:00:00.000Z",
    flip_conditions: [],
    workspace_id: "workspace-1",
    ...overrides
  };
}

describe("SqliteSlotRepo", () => {
  it("applies migration 010 and creates slots table", async () => {
    const { database } = await createRepo();

    const migration = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 10 LIMIT 1")
      .get() as { readonly version: number } | undefined;

    expect(migration?.version).toBe(10);
  });

  it("creates and finds a slot by id", async () => {
    const { repo } = await createRepo();
    const slot = createSlot();

    await expect(repo.create(slot)).resolves.toEqual(slot);
    await expect(repo.findById(slot.object_id)).resolves.toEqual(slot);
  });

  it("enforces unique slot key", async () => {
    const { repo } = await createRepo();

    await repo.create(createSlot({ object_id: SLOT_ID_1 }));

    await expect(
      repo.create(
        createSlot({
          object_id: SLOT_ID_2
        })
      )
    ).rejects.toMatchObject({
      code: "QUERY_FAILED"
    });
  });

  it("finds slot by unique key", async () => {
    const { repo } = await createRepo();

    await repo.create(createSlot({ object_id: SLOT_ID_1 }));
    await repo.create(
      createSlot({
        object_id: SLOT_ID_2,
        governance_subject: canonicalGovernanceSubject("tooling", { manager: "pnpm" }),
        claim_kind: ClaimKind.PREFERENCE
      })
    );

    const found = await repo.findByUniqueKey(
      "security::category=secrets",
      ClaimKind.CONSTRAINT,
      ScopeClass.PROJECT,
      "workspace-1"
    );

    expect(found?.object_id).toBe(SLOT_ID_1);
  });

  it("updates slot winner", async () => {
    const { repo } = await createRepo();

    await repo.create(createSlot({ object_id: SLOT_ID_1 }));
    const updated = await repo.updateWinner(
      SLOT_ID_1,
      CLAIM_ID_2,
      "2026-03-21T01:00:00.000Z",
      "2026-03-21T01:00:00.000Z"
    );

    expect(updated.winner_claim_id).toBe(CLAIM_ID_2);
    expect(updated.incumbent_since).toBe("2026-03-21T01:00:00.000Z");
    expect(updated.updated_at).toBe("2026-03-21T01:00:00.000Z");
  });

  it("lists slots by workspace", async () => {
    const { repo } = await createRepo();

    await repo.create(createSlot({ object_id: SLOT_ID_1, workspace_id: "workspace-1" }));
    await repo.create(
      createSlot({ object_id: SLOT_ID_2, workspace_id: "workspace-1", scope_class: ScopeClass.GLOBAL_DOMAIN })
    );

    const slots = await repo.findByWorkspace("workspace-1");

    expect(slots).toHaveLength(2);
    expect(slots.map((slot) => slot.object_id)).toEqual([SLOT_ID_1, SLOT_ID_2]);
  });
});

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteSlotRepo;
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
    database,
    repo: new SqliteSlotRepo(database)
  };
}
