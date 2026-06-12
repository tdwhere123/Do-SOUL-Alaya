import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteReconciliationLeaseRepo } from "../../../repos/lease/reconciliation-lease-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

function createRepo(): SqliteReconciliationLeaseRepo {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return new SqliteReconciliationLeaseRepo(database);
}

const T0 = "2026-05-22T00:00:00.000Z";
const T0_PLUS_1MIN = "2026-05-22T00:01:00.000Z";
const T0_PLUS_5MIN = "2026-05-22T00:05:00.000Z";
const T0_PLUS_6MIN = "2026-05-22T00:06:00.000Z";
const T0_PLUS_10MIN = "2026-05-22T00:10:00.000Z";

describe("SqliteReconciliationLeaseRepo", () => {
  it("acquires a lease for a free key", () => {
    const repo = createRepo();
    const lease = repo.tryAcquire("ws-1", "owner-a", T0, T0_PLUS_5MIN);
    expect(lease).not.toBeNull();
    expect(lease?.owner_token).toBe("owner-a");
    expect(repo.findByKey("ws-1")?.owner_token).toBe("owner-a");
  });

  it("refuses a second acquire while a live lease is held by another owner", () => {
    const repo = createRepo();
    const first = repo.tryAcquire("ws-1", "owner-a", T0, T0_PLUS_5MIN);
    expect(first).not.toBeNull();

    // owner-b attempts to acquire one minute later — the lease is still live.
    const second = repo.tryAcquire("ws-1", "owner-b", T0_PLUS_1MIN, T0_PLUS_6MIN);
    expect(second).toBeNull();
    // The stored lease is untouched: owner-a still holds it.
    const stored = repo.findByKey("ws-1");
    expect(stored?.owner_token).toBe("owner-a");
    expect(stored?.expires_at).toBe(T0_PLUS_5MIN);
  });

  it("reclaims an expired lease via the same CAS step", () => {
    const repo = createRepo();
    repo.tryAcquire("ws-1", "owner-a", T0, T0_PLUS_5MIN);

    // owner-b acquires AFTER owner-a's lease has expired (now == expiry+).
    const reclaimed = repo.tryAcquire("ws-1", "owner-b", T0_PLUS_6MIN, T0_PLUS_10MIN);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.owner_token).toBe("owner-b");
    const stored = repo.findByKey("ws-1");
    expect(stored?.owner_token).toBe("owner-b");
    expect(stored?.expires_at).toBe(T0_PLUS_10MIN);
  });

  it("treats the exact expiry instant as reclaimable (expires_at <= now)", () => {
    const repo = createRepo();
    repo.tryAcquire("ws-1", "owner-a", T0, T0_PLUS_5MIN);
    // now exactly equals the stored expires_at.
    const reclaimed = repo.tryAcquire("ws-1", "owner-b", T0_PLUS_5MIN, T0_PLUS_10MIN);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.owner_token).toBe("owner-b");
  });

  it("releases a lease so the key is immediately free for another owner", () => {
    const repo = createRepo();
    repo.tryAcquire("ws-1", "owner-a", T0, T0_PLUS_5MIN);
    repo.release("ws-1", "owner-a");
    expect(repo.findByKey("ws-1")).toBeNull();

    const reacquired = repo.tryAcquire("ws-1", "owner-b", T0_PLUS_1MIN, T0_PLUS_6MIN);
    expect(reacquired?.owner_token).toBe("owner-b");
  });

  it("ignores a release from a non-owner so a reclaimed lease is not stolen back", () => {
    const repo = createRepo();
    repo.tryAcquire("ws-1", "owner-a", T0, T0_PLUS_5MIN);
    // owner-a's lease expired and owner-b reclaimed it.
    repo.tryAcquire("ws-1", "owner-b", T0_PLUS_6MIN, T0_PLUS_10MIN);
    // A stale owner-a release must NOT delete owner-b's live lease.
    repo.release("ws-1", "owner-a");
    expect(repo.findByKey("ws-1")?.owner_token).toBe("owner-b");
  });

  it("keeps leases for distinct workspace keys independent", () => {
    const repo = createRepo();
    const a = repo.tryAcquire("ws-1", "owner-a", T0, T0_PLUS_5MIN);
    const b = repo.tryAcquire("ws-2", "owner-b", T0, T0_PLUS_5MIN);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(repo.findByKey("ws-1")?.owner_token).toBe("owner-a");
    expect(repo.findByKey("ws-2")?.owner_token).toBe("owner-b");
  });
});
