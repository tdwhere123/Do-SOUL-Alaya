import { SourceSemanticResourceLedger, SourceSemanticResourceExhausted, type SourceRecordIdentity } from "@do-soul/alaya-protocol";
import { CoreError, authorizeSemanticScope, fieldContractSha256, type FieldFormationStores } from "@do-soul/alaya-core";
import { RETAINED_SOURCE_READ_RESERVATION, SqliteFieldSourceRecordRepo, sourceRecordFromRow, type StorageDatabase } from "@do-soul/alaya-storage";

export class SourceSemanticReadBudget extends SourceSemanticResourceLedger {
  public nativeWork = 0;
  public nativeBytes = 0;
  read(work: number, bytes: number, reason = "native source read"): void {
    this.charge(work, bytes, reason); this.nativeWork += work; this.nativeBytes += bytes;
  }
  absorb(child: SourceSemanticReadBudget): void {
    this.charge(child.spentWork, child.spentBytes, "bounded read phase");
    this.nativeWork += child.nativeWork; this.nativeBytes += child.nativeBytes;
  }
}

/** Each call re-reads current state. In particular, audit callbacks cannot reuse a pre-await source cache. */
export function sourceSemanticReadStores(database: StorageDatabase, workspace: string, artifact: string,
  meter: SourceSemanticReadBudget, authorized: readonly string[] | null): Pick<FieldFormationStores, "getCurrentRecord" | "getStoredRecord"> {
  const repo = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  return {
    getCurrentRecord: (workspaceId, sourceId) => {
      if (workspaceId !== workspace || sourceId !== artifact) throw new CoreError("VALIDATION", "source binding mismatch");
      meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION);
      const page = repo.findCurrentBounded(workspace, artifact, 1);
      meter.read(5, page === null ? 0 : page.nativeBytes + page.metadataBytes);
      if (page === null) return null;
      if (page.record === null) throw new CoreError("CONFLICT", "source metadata is unavailable", {
        details: { admission: "unavailable", unavailable: "metadata" }
      });
      const record = sourceRecordFromRow(page.record);
      meter.retain(record);
      return record;
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
  authorized: readonly string[] | null, preferredSourceIds: readonly string[] = []
): { sources: SourceRecordIdentity[]; truncated: boolean; open: boolean; pages: number;
  stopping_reasons: readonly ("budget" | "source_limit" | "unavailable")[] } {
  if (preferredSourceIds.length > 16 || new Set(preferredSourceIds).size !== preferredSourceIds.length ||
      preferredSourceIds.some((id) => id.length === 0)) {
    throw new CoreError("VALIDATION", "invalid bounded source nomination");
  }
  const repo = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  const sources: SourceRecordIdentity[] = [];
  const accepted = new Set<string>();
  const stoppingReasons = new Set<"budget" | "source_limit" | "unavailable">();
  let afterSourceId: string | null = null, pages = 0, truncated = true, open = false;
  const append = (page: NonNullable<ReturnType<typeof repo.findCurrentBounded>>) => {
    if (page.record === null) { open = true; stoppingReasons.add("unavailable"); return "unavailable" as const; }
    const record = sourceRecordFromRow(page.record);
    if (page.record.source_body === null || page.invalidOffset) {
      if (page.bodyBytes > 0 || page.invalidOffset) { open = true; stoppingReasons.add("unavailable"); }
      return "skipped" as const;
    }
    try { authorizeSemanticScope(record.scope_class, authorized); } catch { return "skipped" as const; }
    if (accepted.has(record.source_id)) return "skipped" as const;
    try { meter.retain(record, "current source catalog"); }
    catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      open = true; stoppingReasons.add("budget"); return "budget" as const;
    }
    accepted.add(record.source_id); sources.push(record);
    return "accepted" as const;
  };
  let exhausted = false;
  for (const sourceId of preferredSourceIds) {
    try { meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION); }
    catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      open = true; stoppingReasons.add("budget"); exhausted = true; break;
    }
    const page = repo.findCurrentBounded(workspace, sourceId, 1);
    meter.read(5, page === null ? 0 : page.nativeBytes + page.metadataBytes);
    pages += 1;
    if (page !== null && append(page) === "budget") { exhausted = true; break; }
  }
  // Every seek skips the preceding source's entire history. The remaining sources stay unvisited.
  while (!exhausted && pages < 512) {
    try { meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION); }
    catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      open = true; truncated = true; stoppingReasons.add("budget"); break;
    }
    const page = repo.findNextCurrentBounded(workspace, afterSourceId, 1);
    meter.read(5, page === null ? 0 : page.nativeBytes + page.metadataBytes);
    pages += 1;
    if (page === null) { truncated = false; break; }
    if (page.record === null) { open = true; stoppingReasons.add("unavailable"); break; }
    afterSourceId = page.record.source_id;
    if (append(page) === "budget") break;
  }
  if (truncated) open = true;
  if (truncated && pages >= 512) stoppingReasons.add("source_limit");
  return {
    sources,
    truncated, open, pages, stopping_reasons: [...stoppingReasons]
  };
}

export function currentSemanticSource(stores: Pick<FieldFormationStores, "getCurrentRecord" | "getStoredRecord">,
  workspace: string, sourceId: string) {
  const current = stores.getCurrentRecord(workspace, sourceId);
  if (current === null) throw new CoreError("NOT_FOUND", "source is not currently admitted", { details: { admission: "no_eligible_source" } });
  const stored = stores.getStoredRecord(workspace, current.identity);
  if (stored === null) throw new CoreError("CONFLICT", "current source body is not available", { details: { admission: "unavailable", unavailable: "source_body" } });
  return stored;
}
