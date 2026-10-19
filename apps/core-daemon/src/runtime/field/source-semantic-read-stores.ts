import { SourceSemanticResourceLedger, SourceSemanticResourceExhausted, type SourceRecordIdentity, type SourceIndexTarget, type SourceIndexQueryResources, type SourceSemanticResourceBudget, type SourceSemanticCompactPreparation, type SourceSemanticCompactAcquisition } from "@do-soul/alaya-protocol";
import { CoreError, authorizeSemanticScope, fieldContractSha256, type FieldFormationStores } from "@do-soul/alaya-core";
import { RETAINED_SOURCE_READ_RESERVATION, SqliteFieldSourceRecordRepo, sourceRecordFromRow, type StorageDatabase } from "@do-soul/alaya-storage";

import type { SourceSemanticObserver } from "../recall-read-worker/source-semantic-observation.js";

export class SourceSemanticReadBudget extends SourceSemanticResourceLedger {
  private readonly observationId: number | undefined;
  constructor(budget: SourceSemanticResourceBudget, public readonly observer?: SourceSemanticObserver,
    public readonly phase = "request", parent: number | null = null) {
    super(budget);
    this.observationId = observer?.meter(id => ({ id, parent, phase, initial: { work_units: budget.work_units, memory_bytes: budget.memory_bytes }, remaining: this.remaining(),
      spent: { work_units: this.spentWork, memory_bytes: this.spentBytes }, held: { work_units: this.heldWork, memory_bytes: this.heldBytes } }));
    observer?.cost(phase, "phase allowance", "allocation", budget.work_units, budget.memory_bytes);
  }
  child(budget: SourceSemanticResourceBudget, phase: string): SourceSemanticReadBudget {
    return new SourceSemanticReadBudget(budget, this.observer, phase, this.observationId ?? null);
  }
  override reserve(work: number, bytes: number, reason = "preparation"): void {
    try { super.reserve(work, bytes, reason); }
    catch (error) { this.observer?.cost(this.phase, reason, "refused", work, bytes); throw error; }
  }
  override charge(work: number, bytes: number, reason = "preparation"): void {
    super.charge(work, bytes, reason);
    this.observer?.cost(this.phase, reason, "debit", work, bytes);
  }
  private operationDepth = 0;
  override retain(value: unknown, reason = "preparation", ownership?: "immutable" | "borrow"): void {
    if (this.observer === undefined) return super.retain(value, reason, ownership);
    const work = this.spentWork, bytes = this.spentBytes, outer = this.operationDepth++ === 0;
    let completed = false;
    try { super.retain(value, reason, ownership); completed = true; }
    finally {
      this.operationDepth--;
      if (outer) this.observer.facts.operation("retain", this.observationId ?? null, this.phase, reason, value,
        this.spentWork - work, this.spentBytes - bytes, completed);
    }
  }
  override canonicalJsonLength(value: unknown, planner?: SourceSemanticResourceLedger): number {
    if (this.observer === undefined) return super.canonicalJsonLength(value, planner);
    const work = this.spentWork, bytes = this.spentBytes, outer = this.operationDepth++ === 0;
    let completed = false;
    try { const length = super.canonicalJsonLength(value, planner); completed = true; return length; }
    finally {
      this.operationDepth--;
      if (outer) this.observer.facts.operation("canonical_scan", this.observationId ?? null, this.phase, "canonical JSON size scan", value,
        this.spentWork - work, this.spentBytes - bytes, completed);
    }
  }
  public preparation?: SourceSemanticCompactPreparation;
  public acquisition?: SourceSemanticCompactAcquisition;
  public indexWork = 0;
  private heldWork = 0;
  private heldBytes = 0;
  public nativeWork = 0;
  public nativeBytes = 0;
  static tupleLookupCost(kind: "catalog" | "discovered", count: number): SourceSemanticResourceBudget {
    return { work_units: count, memory_bytes: count * (kind === "catalog" ? 16 : 24) };
  }
  static signalReconciliationCost(count: number): SourceSemanticResourceBudget {
    return { work_units: count, memory_bytes: 0 };
  }
  read(work: number, bytes: number, reason = "native source read"): void {
    this.charge(work, bytes, reason); this.nativeWork += work; this.nativeBytes += bytes;
    this.observer?.cost(this.phase, reason, "native_read", work, bytes);
  }
  /** A held allowance is not execution. Release it before the quoted completion runs. */
  hold(cost: SourceSemanticResourceBudget): () => void {
    this.reserve(cost.work_units, cost.memory_bytes, "source completion allowance");
    this.work -= cost.work_units; this.bytes -= cost.memory_bytes;
    this.heldWork += cost.work_units; this.heldBytes += cost.memory_bytes;
    this.observer?.cost(this.phase, "source completion allowance", "hold", cost.work_units, cost.memory_bytes);
    let held = true;
    return () => {
      if (!held) return;
      this.work += cost.work_units; this.bytes += cost.memory_bytes;
      this.heldWork -= cost.work_units; this.heldBytes -= cost.memory_bytes; held = false;
      this.observer?.cost(this.phase, "source completion allowance", "release", cost.work_units, cost.memory_bytes);
    };
  }
  outstandingAllowance(): Readonly<{ work_units: number; memory_bytes: number }> {
    return { work_units: this.spentWork + this.heldWork, memory_bytes: this.spentBytes + this.heldBytes };
  }
  constrainToParent(parent: SourceSemanticReadBudget): void {
    this.work = Math.min(this.work, Math.max(0, parent.work - this.spentWork - this.heldWork));
    this.bytes = Math.min(this.bytes, Math.max(0, parent.bytes - this.spentBytes - this.heldBytes));
  }
  absorbIndex(resources: SourceIndexQueryResources): void {
    // Native bytes are already included in memory_bytes, not a second debit.
    this.charge(resources.work, resources.memory_bytes, "source index acquisition");
    this.indexWork += resources.work; this.nativeBytes += resources.native_bytes;
    this.observer?.cost(this.phase, "source index acquisition", "index_native", resources.work, resources.native_bytes);
  }
  absorb(child: SourceSemanticReadBudget): void {
    // This transfer has already been debited by the child; do not count it as new work.
    super.charge(child.spentWork, child.spentBytes, "bounded read phase");
    this.observer?.cost(this.phase, child.phase, "absorb", child.spentWork, child.spentBytes);
    this.observer?.cost(child.phase, "phase remainder at absorption", "unused", child.work, child.bytes);
    this.nativeWork += child.nativeWork; this.nativeBytes += child.nativeBytes; this.indexWork += child.indexWork;
    if (child.acquisition !== undefined) this.acquisition = child.acquisition;
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
      const page = repo.findCurrentBounded(workspace, artifact, 1, 0, { workLimit: meter.work, nativeByteLimit: meter.bytes });
      meter.read(5 + (page?.dependencyWork ?? 0), page === null ? 0 : page.nativeBytes + page.metadataBytes);
      if (page?.resourceLimited) throw new SourceSemanticResourceExhausted("source projection dependencies");
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
        const page = repo.findByIdBounded(workspace, id, 4096, offset, { workLimit: meter.work, nativeByteLimit: meter.bytes });
        meter.read(5 + (page?.dependencyWork ?? 0), page === null ? 0 : page.nativeBytes + page.metadataBytes);
        if (page?.resourceLimited) throw new SourceSemanticResourceExhausted("source projection dependencies");
        if (page?.record == null || page.record.source_body === null || page.invalidOffset) return null;
        record = sourceRecordFromRow(page.record);
        authorizeSemanticScope(record.scope_class, authorized);
        const content = page.record.source_body, bytes = Buffer.byteLength(content);
        meter.observer?.event("source_read", meter.phase, () => ({ purpose: "verification", record_id: id,
          source_id: record!.source_id, start: offset, end: offset + bytes, body_bytes: page.bodyBytes,
          native_bytes: page.nativeBytes + page.metadataBytes }));
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
  authorized: readonly string[] | null, preferredSourceIds: readonly string[] = [],
  union?: Readonly<{ nominations: readonly SourceIndexTarget[]; beforeRetain: (record: SourceRecordIdentity, tuple: string) => void;
    acquire?: (next: SourceRecordIdentity | null, bodyBytes: number) => readonly SourceIndexTarget[] }>
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
        expected.target.workspace_id !== record.workspace_id || expected.target.source_version !== record.source_version ||
        expected.target.content_digest !== record.content_digest)) return "skipped" as const;
    try {
      const tuple = semanticSourceTupleIdentity(record, meter);
      if (accepted.has(tuple)) return "skipped" as const;
      union?.beforeRetain(record, tuple); meter.retain(record, "current source catalog");
      accepted.add(tuple); sources.push(record);
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
        const page = repo.findCurrentBounded(workspace, nomination.source_id, 1, 0,
          { workLimit: meter.work, nativeByteLimit: meter.bytes });
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
    meter.read(5 + (page?.dependencyWork ?? 0), page === null ? 0 : page.nativeBytes + page.metadataBytes);
    pages += 1;
    if (page !== null && append(page, "preferred") === "budget") { exhausted = true; break; }
  }
  // Every seek skips the preceding source's entire history. The remaining sources stay unvisited.
  while (!exhausted && pages < 512) {
    try { meter.reserve(5, RETAINED_SOURCE_READ_RESERVATION); }
    catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      open = true; truncated = true; stoppingReasons.add("budget"); break;
    }
    const page = repo.findNextCurrentBounded(workspace, afterSourceId, 1, { workLimit: meter.work, nativeByteLimit: meter.bytes });
    meter.read(5 + (page?.dependencyWork ?? 0), page === null ? 0 : page.nativeBytes + page.metadataBytes);
    pages += 1;
    if (page === null) {
      if (pages === 1) admitNominations(union?.acquire?.(null, 0) ?? []);
      truncated = false; break;
    }
    if (page.record === null) { open = true; stoppingReasons.add("unavailable"); break; }
    afterSourceId = page.record.source_id;
    if (append(page, "cursor") === "budget") break;
    if (pages === 1) admitNominations(union?.acquire?.(sources[0] ?? null, page.bodyBytes) ?? []);
  }
  if (truncated) open = true;
  if (truncated && pages >= 512) stoppingReasons.add("source_limit");
  return {
    sources,
    truncated, open, pages, stopping_reasons: [...stoppingReasons]
  };
}

export function semanticSourceTupleIdentity(record: SourceRecordIdentity, meter: SourceSemanticReadBudget): string {
  const tuple = `${record.workspace_id}\0${record.identity}\0${record.source_version}\0${record.content_digest}`;
  meter.retain(tuple, "source union tuple identity");
  return tuple;
}

export function currentSemanticSource(stores: Pick<FieldFormationStores, "getCurrentRecord" | "getStoredRecord">,
  workspace: string, sourceId: string) {
  const current = stores.getCurrentRecord(workspace, sourceId);
  if (current === null) throw new CoreError("NOT_FOUND", "source is not currently admitted", { details: { admission: "no_eligible_source" } });
  const stored = stores.getStoredRecord(workspace, current.identity);
  if (stored === null) throw new CoreError("CONFLICT", "current source body is not available", { details: { admission: "unavailable", unavailable: "source_body" } });
  return stored;
}
