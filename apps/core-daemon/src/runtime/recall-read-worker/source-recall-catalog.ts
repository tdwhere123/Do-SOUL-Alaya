import { SourceSemanticResourceExhausted, type SourceRecordIdentity, type SourceIndexTarget } from "@do-soul/alaya-protocol";
import { CoreError, authorizeSemanticScope, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, sourceRecordFromRow, RETAINED_SOURCE_READ_RESERVATION, type StorageDatabase } from "@do-soul/alaya-storage";
import type { SourceRecallAccessMeter } from "./source-recall-access.js";

type CatalogMeter = SourceRecallAccessMeter & { read: (work: number, bytes: number) => void };

/** Current authorized source union; navigation nominates but never establishes membership. */
export function listEligibleSemanticSources(database: StorageDatabase, workspace: string, meter: CatalogMeter,
  authorized: readonly string[] | null, preferredSourceIds: readonly string[] = [],
  union?: Readonly<{ nominations: readonly SourceIndexTarget[]; beforeRetain: (record: SourceRecordIdentity, tuple: string) => void;
    catalogPositions?: Map<string, number>;
    acquire?: (next: SourceRecordIdentity | null, bodyBytes: number) => readonly SourceIndexTarget[] }>
): { sources: SourceRecordIdentity[]; truncated: boolean; open: boolean; pages: number;
  stopping_reasons: readonly ("budget" | "source_limit" | "unavailable")[]; catalog_positions: ReadonlyMap<string, number> | undefined } {
  if (preferredSourceIds.length > 16 || new Set(preferredSourceIds).size !== preferredSourceIds.length || preferredSourceIds.some(id => id.length === 0)) {
    throw new CoreError("VALIDATION", "invalid bounded source nomination");
  }
  const repo = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  const sources: SourceRecordIdentity[] = [], accepted = new Set<string>();
  const stoppingReasons = new Set<"budget" | "source_limit" | "unavailable">();
  let afterSourceId: string | null = null, pages = 0, truncated = true, open = false;
  const append = (page: NonNullable<ReturnType<typeof repo.findCurrentBounded>>, route: string, expected?: SourceIndexTarget) => {
    if (page.resourceLimited) { open = true; stoppingReasons.add("budget"); return "budget" as const; }
    if (page.record === null) { open = true; stoppingReasons.add("unavailable"); return "unavailable" as const; }
    const record = sourceRecordFromRow(page.record);
    if (page.record.source_body === null || page.invalidOffset) {
      if (page.bodyBytes > 0 || page.invalidOffset) { open = true; stoppingReasons.add("unavailable"); }
      return "skipped" as const;
    }
    try { authorizeSemanticScope(record.scope_class, authorized); } catch { return "skipped" as const; }
    if (expected !== undefined && (expected.source_id !== record.source_id || expected.target.root_id !== record.identity ||
      expected.target.workspace_id !== record.workspace_id || expected.target.source_version !== record.source_version || expected.target.content_digest !== record.content_digest)) return "skipped" as const;
    try {
      const tuple = semanticSourceTupleIdentity(record, meter);
      if (accepted.has(tuple)) return "skipped" as const;
      meter.retain(record, "current source catalog", "immutable");
      union?.beforeRetain(record, tuple); accepted.add(tuple); sources.push(record);
      meter.observer?.event("union_admission", meter.phase, () => ({ route, position: sources.length - 1,
        record_id: record.identity, source_id: record.source_id, source_version: record.source_version, content_digest: record.content_digest }));
      return "accepted" as const;
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      open = true; stoppingReasons.add("budget"); return "budget" as const;
    }
  };
  let exhausted = false;
  const admitNominations = (nominations: readonly SourceIndexTarget[]) => {
    for (const nomination of nominations) {
      try {
        meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION);
        const page = repo.findCurrentBounded(workspace, nomination.source_id, 1, 0, { workLimit: meter.work, nativeByteLimit: meter.bytes });
        meter.read(5 + (page?.dependencyWork ?? 0), page === null ? 0 : page.nativeBytes + page.metadataBytes);
        if (page !== null && append(page, "source_index", nomination) === "budget") { exhausted = true; break; }
      } catch (error) {
        if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
        open = true; stoppingReasons.add("budget"); exhausted = true; break;
      }
    }
  };
  admitNominations(union?.nominations ?? []);
  for (const sourceId of preferredSourceIds) {
    try { meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION); }
    catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      open = true; stoppingReasons.add("budget"); exhausted = true; break;
    }
    const page = repo.findCurrentBounded(workspace, sourceId, 1, 0, { workLimit: meter.work, nativeByteLimit: meter.bytes });
    meter.read(5 + (page?.dependencyWork ?? 0), page === null ? 0 : page.nativeBytes + page.metadataBytes); pages++;
    if (page !== null && append(page, "preferred") === "budget") { exhausted = true; break; }
  }
  while (!exhausted && pages < 512) {
    try { meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION); }
    catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      open = true; truncated = true; stoppingReasons.add("budget"); break;
    }
    const page = repo.findNextCurrentBounded(workspace, afterSourceId, 1, { workLimit: meter.work, nativeByteLimit: meter.bytes });
    meter.read(5 + (page?.dependencyWork ?? 0), page === null ? 0 : page.nativeBytes + page.metadataBytes); pages++;
    if (page === null) {
      if (pages === 1) admitNominations(union?.acquire?.(null, 0) ?? []);
      truncated = false; break;
    }
    if (page.record === null) { open = true; stoppingReasons.add("unavailable"); break; }
    afterSourceId = page.record.source_id;
    // This is the actual cursor-page position, not the final union array index.
    if (union?.catalogPositions !== undefined) {
      meter.charge(1, 96, "captured source catalog position");
      union.catalogPositions.set(sourceRecordFromRow(page.record).identity, pages - 1);
    }
    if (append(page, "cursor") === "budget") break;
    if (pages === 1) admitNominations(union?.acquire?.(sources[0] ?? null, page.bodyBytes) ?? []);
  }
  if (truncated) open = true;
  if (truncated && pages >= 512) stoppingReasons.add("source_limit");
  return { sources, truncated, open, pages, stopping_reasons: [...stoppingReasons], catalog_positions: union?.catalogPositions };
}
export function semanticSourceTupleIdentity(record: SourceRecordIdentity, meter: SourceRecallAccessMeter): string {
  const tuple = `${record.workspace_id}\0${record.identity}\0${record.source_version}\0${record.content_digest}`;
  meter.retain(tuple, "source union tuple identity"); return tuple;
}
