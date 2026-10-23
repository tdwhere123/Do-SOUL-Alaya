import { AlayaError } from "@do-soul/alaya-protocol";
import type { SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";

export const NAVIGATION_SOURCE_READ_ALLOWANCE = { work_units: 100_000, native_bytes: 128 * 1024 } as const;
export const NAVIGATION_READ_LIMITS = { source_reads: 522, requested_prefix_bytes: 512 + 10 * 4096,
  work_units: 522 * NAVIGATION_SOURCE_READ_ALLOWANCE.work_units,
  native_bytes: 522 * NAVIGATION_SOURCE_READ_ALLOWANCE.native_bytes } as const;
export type ReadAccounting = { status: "complete" | "partial"; source_reads: number; requested_prefix_bytes: number;
  native_bytes: number; metadata_bytes: number; dependency_work: number; unmetered_reads: number };
export const navigationReadAccounting = (): ReadAccounting => ({ status: "complete", source_reads: 0,
  requested_prefix_bytes: 0, native_bytes: 0, metadata_bytes: 0, dependency_work: 0, unmetered_reads: 0 });
export type AnchorAccounting = { status: "complete" | "partial"; attempts: number; completed: number;
  native_bytes_including_metadata: number; native_work: number; physical_reads: null };
export const anchorAccounting = (): AnchorAccounting => ({ status: "complete", attempts: 0, completed: 0,
  native_bytes_including_metadata: 0, native_work: 0, physical_reads: null });

/** A prefix invocation is one bounded Storage call. A located invocation is one
 * opaque native hydration (currentness plus potentially several chunks). The
 * shared cap counts logical requests, NOT an invented physical operation count.
 * Quotes are never refunded or reset between observation, seed and delivery. */
export function navigationReadLedger(maxSourceReads: number) {
  return { allowance: { ...NAVIGATION_READ_LIMITS, source_reads: maxSourceReads },
    reservation_unit: "logical_read_request_not_physical_operation" as const,
    accounting: navigationReadAccounting(), located_accounting: anchorAccounting(),
    reserved: { work_units: 0, native_bytes: 0, logical_requests: 0, requested_bytes: 0 }, reused_delivery_reads: 0 };
}
export type NavigationReadLedger = ReturnType<typeof navigationReadLedger>;

/** Same conservative per-operation quote for both readers. Requested bytes are
 * prefix or located extent, not physical bytes; actual meters remain separate. */
export function reserveNavigationRead(ledger: NavigationReadLedger | undefined, requestedBytes: number): boolean {
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0) {
    throw new AlayaError("VALIDATION", "invalid navigation read reservation extent");
  }
  if (!ledger) return true;
  const { reserved, allowance } = ledger, quote = NAVIGATION_SOURCE_READ_ALLOWANCE;
  if (reserved.logical_requests >= allowance.source_reads ||
      reserved.requested_bytes + requestedBytes > allowance.requested_prefix_bytes ||
      reserved.work_units + quote.work_units > allowance.work_units ||
      reserved.native_bytes + quote.native_bytes > allowance.native_bytes) return false;
  reserved.logical_requests++; reserved.requested_bytes += requestedBytes;
  reserved.work_units += quote.work_units; reserved.native_bytes += quote.native_bytes;
  return true;
}

/** Retain known native meters even after rejection or a later write failure.
 * An interrupted opaque hydration can hide operations beyond its exposed meter;
 * its failed attempt remains partial, and physical_reads remains unknown. */
export function accountLocatedRead<T>(accounting: AnchorAccounting, ledger: NavigationReadLedger | undefined,
  meter: { readonly nativeBytes: number; readonly nativeWork: number }, read: () => T): T {
  const accounts = [...new Set([accounting, ...(ledger ? [ledger.located_accounting] : [])])];
  for (const account of accounts) { account.attempts++; account.status = "partial"; }
  try {
    const result = read();
    for (const account of accounts) account.completed++;
    return result;
  } finally {
    for (const account of accounts) {
      account.native_bytes_including_metadata += meter.nativeBytes; account.native_work += meter.nativeWork;
      account.status = account.attempts === account.completed ? "complete" : "partial";
    }
  }
}

/** Reserve before invoking Storage, retain known meters on rejection, and never
 * represent a thrown/null meter as zero work. Prefix meters count only these
 * direct Storage invocations; located hydrations have their own opaque meters. */
export function readNavigationSource(records: SqliteFieldSourceRecordRepo, workspace: string, recordId: string | { current_source_id: string },
  prefixBytes: number, accounting: ReadAccounting, ledger?: NavigationReadLedger) {
  const { work_units: work, native_bytes: bytes } = NAVIGATION_SOURCE_READ_ALLOWANCE;
  if (!reserveNavigationRead(ledger, prefixBytes)) throw new AlayaError("UNAVAILABLE", "shared navigation read allowance exhausted");
  const accounts = [...new Set([accounting, ...(ledger ? [ledger.accounting] : [])])];
  for (const account of accounts) {
    account.source_reads++; account.requested_prefix_bytes += prefixBytes; account.unmetered_reads++; account.status = "partial";
  }
  try {
    const read = typeof recordId === "string"
      ? records.findByIdBounded(workspace, recordId, prefixBytes, 0, { workLimit: work, nativeByteLimit: bytes })
      : records.findCurrentBounded(workspace, recordId.current_source_id, prefixBytes, 0, { workLimit: work, nativeByteLimit: bytes });
    if (read !== null) for (const account of accounts) {
      account.unmetered_reads--; account.native_bytes += read.nativeBytes;
      account.metadata_bytes += read.metadataBytes; account.dependency_work += read.dependencyWork;
    }
    return read;
  } finally {
    for (const account of accounts) account.status = account.unmetered_reads === 0 ? "complete" : "partial";
  }
}
export type NavigationSourceRead = ReturnType<typeof readNavigationSource>;

/** Inclusive known costs, not a physical-I/O estimate. Prefix dependency work
 * and the native owner's work units retain their distinct meter meanings. */
export function navigationReadTotals(ledger: NavigationReadLedger) {
  const prefix = ledger.accounting, located = ledger.located_accounting;
  return { status: prefix.status === "complete" && located.status === "complete" ? "complete" : "partial",
    logical_requests: prefix.source_reads + located.attempts,
    bounded_prefix_calls: prefix.source_reads, physical_reads: null,
    native_bytes_including_metadata: prefix.native_bytes + prefix.metadata_bytes + located.native_bytes_including_metadata,
    prefix_dependency_work: prefix.dependency_work, located_native_work: located.native_work };
}
