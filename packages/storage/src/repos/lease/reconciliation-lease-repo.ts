import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { parseNonEmptyString } from "../shared/validators.js";

// invariant: the storage-level advisory lease that gives multi-process
// ingest reconciliation a cross-process critical section. A reconciliation
// pass wraps an un-transactionable LLM round trip, so it cannot live in one
// SQLite transaction; the lease is the substitute. lease_key is the
// workspace_id (one reconcile per workspace at a time); owner_token names
// the holder so release/reclaim only touch a lease the caller owns;
// expires_at is a TTL so a crashed holder cannot wedge ingest forever.
export interface ReconciliationLease {
  readonly lease_key: string;
  readonly owner_token: string;
  readonly acquired_at: string;
  readonly expires_at: string;
}

interface ReconciliationLeaseRow {
  readonly lease_key: string;
  readonly owner_token: string;
  readonly acquired_at: string;
  readonly expires_at: string;
}

export interface ReconciliationLeaseRepo {
  /**
   * Compare-and-set lease acquire. Succeeds (returns the lease) only when
   * no row for `leaseKey` exists, or the existing row is already expired
   * (`expires_at <= nowIso`) — an expired holder is reclaimed in the same
   * atomic step. Returns null when a live lease is held by someone else.
   */
  tryAcquire(
    leaseKey: string,
    ownerToken: string,
    nowIso: string,
    expiresAtIso: string
  ): Readonly<ReconciliationLease> | null;
  /** Release a lease the caller owns. A no-op if the caller is not the
   *  current owner (a reclaimed-then-expired lease must not be deleted by
   *  the stale original holder). */
  release(leaseKey: string, ownerToken: string): void;
  findByKey(leaseKey: string): Readonly<ReconciliationLease> | null;
}

export class SqliteReconciliationLeaseRepo implements ReconciliationLeaseRepo {
  private readonly acquireStatement;
  private readonly releaseStatement;
  private readonly findByKeyStatement;

  public constructor(db: StorageDatabase) {
    // invariant: the INSERT-OR-CONFLICT CAS. The INSERT wins outright when
    // no row exists. On a key collision the DO UPDATE fires, but the
    // `WHERE` clause restricts the overwrite to a lease whose stored
    // expires_at is already at or before now — so a live lease held by
    // another owner is left untouched and `changes` stays 0. Reclaiming
    // an expired lease and a first acquire are the only ways `changes`
    // becomes 1.
    this.acquireStatement = db.connection.prepare(`
      INSERT INTO reconciliation_leases (
        lease_key,
        owner_token,
        acquired_at,
        expires_at
      ) VALUES (@lease_key, @owner_token, @acquired_at, @expires_at)
      ON CONFLICT(lease_key) DO UPDATE SET
        owner_token = excluded.owner_token,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
      WHERE reconciliation_leases.expires_at <= @now
    `);

    this.releaseStatement = db.connection.prepare(`
      DELETE FROM reconciliation_leases
      WHERE lease_key = ? AND owner_token = ?
    `);

    this.findByKeyStatement = db.connection.prepare(`
      SELECT lease_key, owner_token, acquired_at, expires_at
      FROM reconciliation_leases
      WHERE lease_key = ?
      LIMIT 1
    `);
  }

  public tryAcquire(
    leaseKey: string,
    ownerToken: string,
    nowIso: string,
    expiresAtIso: string
  ): Readonly<ReconciliationLease> | null {
    const parsedLeaseKey = parseNonEmptyString(leaseKey, "lease key");
    const parsedOwnerToken = parseNonEmptyString(ownerToken, "owner token");
    const parsedNow = parseIsoString(nowIso, "now");
    const parsedExpiresAt = parseIsoString(expiresAtIso, "expires at");

    try {
      const result = this.acquireStatement.run({
        lease_key: parsedLeaseKey,
        owner_token: parsedOwnerToken,
        acquired_at: parsedNow,
        expires_at: parsedExpiresAt,
        now: parsedNow
      });
      if (result.changes === 0) {
        return null;
      }
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to acquire reconciliation lease ${parsedLeaseKey}.`,
        error
      );
    }

    // The CAS won; the stored row is exactly what was just written.
    return Object.freeze({
      lease_key: parsedLeaseKey,
      owner_token: parsedOwnerToken,
      acquired_at: parsedNow,
      expires_at: parsedExpiresAt
    });
  }

  public release(leaseKey: string, ownerToken: string): void {
    const parsedLeaseKey = parseNonEmptyString(leaseKey, "lease key");
    const parsedOwnerToken = parseNonEmptyString(ownerToken, "owner token");

    try {
      this.releaseStatement.run(parsedLeaseKey, parsedOwnerToken);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to release reconciliation lease ${parsedLeaseKey}.`,
        error
      );
    }
  }

  public findByKey(leaseKey: string): Readonly<ReconciliationLease> | null {
    const parsedLeaseKey = parseNonEmptyString(leaseKey, "lease key");

    try {
      const row = this.findByKeyStatement.get(parsedLeaseKey) as
        | ReconciliationLeaseRow
        | undefined;
      return row === undefined ? null : parseReconciliationLeaseRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load reconciliation lease ${parsedLeaseKey}.`,
        error
      );
    }
  }
}

function parseReconciliationLeaseRow(
  row: ReconciliationLeaseRow
): Readonly<ReconciliationLease> {
  return Object.freeze({
    lease_key: parseNonEmptyString(row.lease_key, "lease key"),
    owner_token: parseNonEmptyString(row.owner_token, "owner token"),
    acquired_at: parseIsoString(row.acquired_at, "acquired at"),
    expires_at: parseIsoString(row.expires_at, "expires at")
  });
}

function parseIsoString(value: string, fieldName: string): string {
  const parsed = parseNonEmptyString(value, fieldName);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new StorageError("VALIDATION_FAILED", `Invalid ${fieldName} timestamp.`);
  }
  return parsed;
}
