import { afterAll, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../support/strict-provider-free-boundary.js");
  return { safe: installProviderFreeBoundary(), strict: installStrictProviderFreeBoundary() };
});
afterAll(() => {
  expect(boundary.safe.violations).toEqual([]); expect(boundary.strict.forbidden).toEqual([]);
  boundary.strict.restore(); boundary.safe.restore();
});
import { accountLocatedRead, anchorAccounting, NAVIGATION_SOURCE_READ_ALLOWANCE, navigationReadAccounting,
  navigationReadLedger, navigationReadTotals, readNavigationSource, reserveNavigationRead } from "../../../runs/source-access-diagnostic/navigation-read-budget.js";
import { SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { fixture, publishSource, fieldSha256, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";

it("shares the original requested-byte envelope without a free seed or located read", () => {
  const ledger = navigationReadLedger(522);
  // 512 admitted sources, one of them read as the 4096-byte seed rather than a probe.
  expect(reserveNavigationRead(ledger, 4096)).toBe(true);
  for (let i = 0; i < 511; i++) expect(reserveNavigationRead(ledger, 1)).toBe(true);
  for (let i = 0; i < 9; i++) expect(reserveNavigationRead(ledger, 4096)).toBe(true);
  const before = structuredClone(ledger.reserved);
  expect(reserveNavigationRead(ledger, 4096)).toBe(false);
  expect(ledger.reserved).toEqual(before);
  expect(before).toEqual({ logical_requests: 521, requested_bytes: 41471,
    work_units: 521 * 100000, native_bytes: 521 * 131072 });
  expect(ledger.allowance.requested_prefix_bytes).toBe(41472);
});
it("counts reservations separately from actual meters, logical attempts and unknown physical operations", () => {
  const ledger = navigationReadLedger(2), account = anchorAccounting();
  const meter = { nativeBytes: 41, nativeWork: 7 };
  expect(reserveNavigationRead(ledger, 12)).toBe(true);
  accountLocatedRead(account, ledger, meter, () => "available");
  expect(reserveNavigationRead(ledger, 12)).toBe(true);
  expect(() => accountLocatedRead(account, ledger, meter, () => { throw new Error("lost later meter"); })).toThrow();
  expect(reserveNavigationRead(ledger, 1)).toBe(false);
  expect(account).toEqual({ status: "partial", attempts: 2, completed: 1,
    native_bytes_including_metadata: 82, native_work: 14, physical_reads: null });
  expect(ledger.located_accounting).toEqual(account);
  expect(navigationReadTotals(ledger)).toEqual({ status: "partial", logical_requests: 2, bounded_prefix_calls: 0,
    physical_reads: null, native_bytes_including_metadata: 82, prefix_dependency_work: 0, located_native_work: 14 });
  expect(ledger.reserved.native_bytes).toBe(2 * NAVIGATION_SOURCE_READ_ALLOWANCE.native_bytes);
});
it("does not dispatch when exhausted and retains prior and rejected known SQLite costs", () => {
  const db = fixture();
  try {
    const record = publishSource(db, "authored metered source", "metered-source");
    const repo = new SqliteFieldSourceRecordRepo(db.database, fieldSha256), ledger = navigationReadLedger(2);
    const account = navigationReadAccounting();
    const first = readNavigationSource(repo, WORKSPACE, record.record_id, 1, account, ledger)!;
    const original = repo.findByIdBounded.bind(repo);
    const spy = vi.spyOn(repo, "findByIdBounded").mockImplementation((...args) => {
      const read = original(...args)!;
      return { ...read, resourceLimited: true };
    });
    const rejected = readNavigationSource(repo, WORKSPACE, record.record_id, 1, account, ledger)!;
    expect(rejected.resourceLimited).toBe(true);
    expect(account.native_bytes).toBe(first.nativeBytes + rejected.nativeBytes);
    expect(account.metadata_bytes).toBe(first.metadataBytes + rejected.metadataBytes);
    expect(account.dependency_work).toBe(first.dependencyWork + rejected.dependencyWork);
    expect(account.status).toBe("complete");
    expect(() => readNavigationSource(repo, WORKSPACE, record.record_id, 1, account, ledger)).toThrow(/exhausted/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ledger.accounting).toEqual(account);
  } finally { db.database.close({ optimize: false }); }
});
it("retains prior known SQLite costs when a later call throws or loses its meter", () => {
  const db = fixture();
  try {
    const record = publishSource(db, "authored metered source", "metered-source");
    for (const mode of ["throw", "null"] as const) {
      const repo = new SqliteFieldSourceRecordRepo(db.database, fieldSha256), ledger = navigationReadLedger(2);
      const account = navigationReadAccounting(), first = readNavigationSource(repo, WORKSPACE, record.record_id, 1, account, ledger)!;
      const original = repo.findByIdBounded.bind(repo);
      vi.spyOn(repo, "findByIdBounded").mockImplementation((...args) => {
        original(...args);
        if (mode === "throw") throw new Error("lost SQLite meter");
        return null;
      });
      if (mode === "throw") expect(() => readNavigationSource(repo, WORKSPACE, record.record_id, 1, account, ledger)).toThrow();
      else expect(readNavigationSource(repo, WORKSPACE, record.record_id, 1, account, ledger)).toBeNull();
      expect(account).toMatchObject({ status: "partial", source_reads: 2, unmetered_reads: 1,
        native_bytes: first.nativeBytes, metadata_bytes: first.metadataBytes, dependency_work: first.dependencyWork });
      expect(ledger.accounting).toEqual(account);
    }
  } finally { db.database.close({ optimize: false }); }
});
