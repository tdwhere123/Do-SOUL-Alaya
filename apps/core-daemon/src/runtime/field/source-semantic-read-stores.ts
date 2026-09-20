import { SourceSemanticResourceLedger, SourceSemanticResourceExhausted, compareUtcInstants, type SourceRecordIdentity } from "@do-soul/alaya-protocol";
import { CoreError, fieldContractSha256, type FieldFormationStores } from "@do-soul/alaya-core";
import { RETAINED_SOURCE_READ_RESERVATION, SqliteFieldSourceRecordRepo, sourceRecordFromRow, type StorageDatabase } from "@do-soul/alaya-storage";

export class SourceSemanticReadBudget extends SourceSemanticResourceLedger {
  public nativeWork = 0;
  public nativeBytes = 0;
  read(work: number, bytes: number): void {
    this.charge(work, bytes, "native source read"); this.nativeWork += work; this.nativeBytes += bytes;
  }
  absorb(child: SourceSemanticReadBudget): void {
    this.charge(child.spentWork, child.spentBytes, "bounded read phase");
    this.nativeWork += child.nativeWork; this.nativeBytes += child.nativeBytes;
  }
}

/** Each call re-reads current state. In particular, audit callbacks cannot reuse a pre-await source cache. */
export function sourceSemanticReadStores(database: StorageDatabase, workspace: string, artifact: string,
  meter: SourceSemanticReadBudget, authorized: readonly string[] | null): Pick<FieldFormationStores, "listRecords" | "getStoredRecord"> {
  const repo = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  return {
    listRecords: (workspaceId) => {
      if (workspaceId !== workspace) throw new CoreError("VALIDATION", "source workspace mismatch");
      const records: SourceRecordIdentity[] = [];
      let afterRecordedAt = "", afterRecordId = "";
      while (true) {
        meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION);
        const page = repo.listPageBounded(workspace, { limit: 1, afterRecordedAt, afterRecordId }, 1);
        meter.read(5, page.rows.reduce((sum, row) => sum + row.nativeBytes + row.metadataBytes, 0));
        if (page.unavailable) throw new CoreError("CONFLICT", "source catalog is unavailable", { details: { admission: "unavailable", unavailable: "catalog" } });
        const row = page.rows[0]?.record;
        if (row == null) {
          if (page.rows.length !== 0) throw new CoreError("CONFLICT", "source metadata is unavailable", { details: { admission: "unavailable", unavailable: "metadata" } });
          break;
        }
        if (row.source_id === artifact) { const record = sourceRecordFromRow(row); meter.retain(record); records.push(record); }
        afterRecordedAt = row.recorded_at; afterRecordId = row.record_id;
        if (!page.truncated) break;
      }
      return records;
    },
    getStoredRecord: (workspaceId, id) => {
      if (workspaceId !== workspace) throw new CoreError("VALIDATION", "source workspace mismatch");
      let offset = 0, record: SourceRecordIdentity | undefined;
      const chunks: string[] = [];
      while (true) {
        meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION);
        const page = repo.findByIdBounded(workspace, id, 4096, offset);
        meter.read(5, page === null ? 0 : page.nativeBytes + page.metadataBytes);
        if (page?.record == null || page.record.source_body === null || page.invalidOffset) return null;
        record = sourceRecordFromRow(page.record);
        authorizeSemanticScope(record.scope_class, authorized);
        const content = page.record.source_body, bytes = Buffer.byteLength(content);
        meter.charge(0, 4 * content.length + 32, "source retention");
        chunks.push(content); offset += bytes;
        if (offset >= page.bodyBytes) break;
        if (bytes === 0) throw new CoreError("CONFLICT", "source chunk did not advance");
      }
      meter.charge(0, offset * 2, "source assembly");
      return { record, content_bytes: chunks.join("") };
    }
  };
}

/** Current authorized source identities. Query text is not a membership predicate. */
export function listEligibleSemanticSources(
  database: StorageDatabase, workspace: string, meter: SourceSemanticReadBudget,
  authorized: readonly string[] | null
): { sources: SourceRecordIdentity[]; truncated: boolean; open: boolean; pages: number } {
  const repo = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  const latest = new Map<string, { record: SourceRecordIdentity; allowed: boolean }>();
  let afterRecordedAt = "", afterRecordId = "", pages = 0, truncated = false, open = false;
  while (pages < 32) {
    try { meter.reserve(16 * 5, 16 * RETAINED_SOURCE_READ_RESERVATION); }
    catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      open = true; truncated = true; break;
    }
    const page = repo.listPageBounded(workspace, { limit: 16, afterRecordedAt, afterRecordId }, 1);
    meter.read(Math.max(1, page.rows.length) * 5, page.rows.reduce((sum, row) => sum + row.nativeBytes + row.metadataBytes, 0));
    pages += 1;
    if (page.unavailable === true) { open = true; break; }
    for (const row of page.rows) {
      if (row.record == null) { open = true; continue; }
      const record = sourceRecordFromRow(row.record);
      const deleted = row.record.source_body === null;
      if (deleted && row.bodyBytes > 0) open = true;
      let allowed = !deleted;
      if (allowed) {
        try { authorizeSemanticScope(record.scope_class, authorized); } catch { allowed = false; }
      }
      const prev = latest.get(record.source_id);
      const order = prev === undefined ? 1 : compareUtcInstants(prev.record.recorded_at, record.recorded_at);
      if (prev === undefined || order === -1 || order === 0 && prev.record.identity < record.identity) {
        try { meter.retain(record, "current source catalog"); }
        catch (error) {
          if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
          return { sources: [], truncated: true, open: true, pages };
        }
        latest.set(record.source_id, { record, allowed });
      }
    }
    const last = page.rows.at(-1)?.record;
    if (last == null) { truncated = page.truncated; break; }
    afterRecordedAt = last.recorded_at; afterRecordId = last.record_id;
    truncated = page.truncated;
    if (!page.truncated) break;
  }
  if (truncated) open = true;
  return {
    // A historical prefix cannot establish currentness: later exclusions and erasures supersede it too.
    sources: (open || truncated ? [] : [...latest.values()]).filter((row) => row.allowed).map((row) => row.record)
      .sort((left, right) => left.identity.localeCompare(right.identity)),
    truncated, open, pages
  };
}

export function currentSemanticSource(stores: Pick<FieldFormationStores, "listRecords" | "getStoredRecord">,
  workspace: string, sourceId: string) {
  const records = stores.listRecords(workspace).filter((row) => row.source_id === sourceId);
  if (records.length === 0) throw new CoreError("NOT_FOUND", "source is not currently admitted", { details: { admission: "no_eligible_source" } });
  const current = records.reduce((a, b) => {
    const order = compareUtcInstants(a.recorded_at, b.recorded_at);
    return order === -1 || order === 0 && a.identity < b.identity ? b : a;
  });
  const stored = stores.getStoredRecord(workspace, current.identity);
  if (stored === null) throw new CoreError("CONFLICT", "current source body is not available", { details: { admission: "unavailable", unavailable: "source_body" } });
  return stored;
}

export function authorizeSemanticScope(scope: string | null | undefined, authorized: readonly string[] | null): void {
  if (scope == null) throw new CoreError("VALIDATION", "source has no governed scope", { details: { admission: "filtered" } });
  if (authorized !== null && !authorized.includes(scope)) {
    throw new CoreError("VALIDATION", "source is outside authorized scopes", { details: { admission: "filtered" } });
  }
}
