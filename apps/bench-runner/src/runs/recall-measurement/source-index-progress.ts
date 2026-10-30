import BetterSqlite3 from "better-sqlite3";
import { sqliteHostFilename } from "@do-soul/alaya-storage/sqlite/open-sqlite-connection";
import { canonicalJson, sourceIndexGenerationId, sourceIndexConfigurationId, sourceIndexProfileId,
  type SourceIndexGeneration, type SourceIndexSelection, type SourceIndexPendingResult,
  type SourceIndexTarget } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteSourceIndexRepository, StorageDatabase } from "@do-soul/alaya-storage";
import { sourceIndexMeasurementCapability } from "./index-qualification.js";

const ROOT_LIMIT = 16;
const PENDING_BUDGET = Object.freeze({ work: 1, native_bytes: 8 });
type DiagnosticCost = { metadata_transactions: number; target_rows: number; pending_reads: number;
  work: number; native_bytes: number; sql_internal_work: "unknown" };
type Metadata = { workspace_id: string; source_epoch: number; selection: SourceIndexSelection | null;
  generation_id: string | null; generation: SourceIndexGeneration | null; targets: readonly SourceIndexTarget[] };
export type SourceIndexProgressSnapshot = {
  status: "observed" | "unknown"; reason: string | null; metadata: Metadata | null;
  pending: { root_key: string; result: SourceIndexPendingResult }[];
  cost: DiagnosticCost; elapsed_ms: number;
};
export type SourceIndexProgressComparison = { status: "progress" | "no_progress" | "unknown"; reason: string };

/** No scheduled producer is started by preparation. Each metadata read is one frozen transaction;
 * pendingWindows must own its own transaction (it rejects transaction-bearing callers). Fence its
 * bounded reads with identical metadata transactions, rather than bypassing that native owner.
 * Refusal, racing metadata or missing capability cannot certify a stall. Physical SQL cost is unknown.
 */
export function captureSourceIndexProgress(filename: string, workspace: string, signal?: AbortSignal): SourceIndexProgressSnapshot {
  const started = performance.now();
  const result: SourceIndexProgressSnapshot = { status: "unknown", reason: null, metadata: null, pending: [],
    cost: { metadata_transactions: 0, target_rows: 0, pending_reads: 0, work: 0, native_bytes: 0,
      sql_internal_work: "unknown" }, elapsed_ms: 0 };
  let connection: InstanceType<typeof BetterSqlite3> | undefined;
  try {
    if (signal?.aborted) { result.reason = "scope_cancelled"; return result; }
    connection = new BetterSqlite3(sqliteHostFilename(filename), { readonly: true, fileMustExist: true, timeout: 50 });
    connection.pragma("query_only = ON");
    const database = new StorageDatabase(filename, connection);
    const repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
    const measurement = sourceIndexMeasurementCapability();
    const metadata = () => connection!.transaction((): Metadata => {
      result.cost.metadata_transactions++;
      const fact = measurement.readSnapshot(database, workspace);
      const id = fact.selection === null ? null : sourceIndexGenerationId(fact.selection, fact.source_epoch, fieldContractSha256);
      const generation = id === null ? null : repository.generation(workspace, id);
      const targets = generation === null ? [] : repository.listTargets(workspace, generation.generation_id, null, ROOT_LIMIT);
      result.cost.target_rows += targets.length;
      return { workspace_id: fact.workspace_id, source_epoch: fact.source_epoch, selection: fact.selection,
        generation_id: id, generation, targets };
    })();
    const before = metadata();
    result.metadata = before;
    if (before.generation === null) { result.reason = "generation_unavailable"; return result; }
    for (const target of before.targets) {
      result.cost.pending_reads++;
      const pending = repository.pendingWindows(workspace, before.generation.generation_id, target.root_key, 1, PENDING_BUDGET);
      result.cost.work += pending.resources.work;
      result.cost.native_bytes += pending.resources.native_bytes;
      result.pending.push({ root_key: target.root_key, result: pending });
    }
    if (canonicalJson(before) !== canonicalJson(metadata())) { result.reason = "metadata_changed_during_capture"; return result; }
    result.status = "observed";
    return result;
  } catch (error) {
    // These costs are separate from producer charges and remain lower bounds after a thrown read.
    if (error !== null && typeof error === "object" && "resources" in error) {
      const cost = error.resources as { work?: number; native_bytes?: number };
      if (Number.isSafeInteger(cost.work) && cost.work! >= 0) result.cost.work += cost.work!;
      if (Number.isSafeInteger(cost.native_bytes) && cost.native_bytes! >= 0) result.cost.native_bytes += cost.native_bytes!;
    }
    result.reason = error instanceof Error ? error.message.slice(0, 512) : "diagnostic_read_failed";
    return result;
  } finally {
    connection?.close();
    result.elapsed_ms = performance.now() - started;
  }
}

function validMetadata(value: Metadata): boolean {
  const selection = value.selection, generation = value.generation;
  return selection !== null && generation !== null && selection.workspace_id === value.workspace_id &&
    sourceIndexConfigurationId(selection.configuration, fieldContractSha256) === selection.config_id &&
    sourceIndexProfileId(selection.configuration.profile, fieldContractSha256) === selection.profile_id &&
    sourceIndexGenerationId(selection, value.source_epoch, fieldContractSha256) === generation.generation_id &&
    generation.source_epoch === value.source_epoch && canonicalJson(selection) === canonicalJson(generation.selection);
}

export function sourceIndexProgressBindingMatches(snapshot: SourceIndexProgressSnapshot,
  binding: { profile_id: string; profile: unknown }): boolean {
  const metadata = snapshot.metadata;
  if (snapshot.pending.some(row => ["stale", "superseded", "unbound"].includes(row.result.status))) return false;
  // Unavailable diagnostics are not a native unbound receipt. The producer still owns that outcome.
  if (metadata?.generation === null || metadata === null) return true;
  return validMetadata(metadata) && !["failed", "retired"].includes(metadata.generation.status) &&
    metadata.selection!.profile_id === binding.profile_id &&
    canonicalJson(metadata.selection!.configuration.profile) === canonicalJson(binding.profile);
}

/** Counts/cursors establish capture progress even when the bounded captured-root set is partial.
 * A stall needs a complete comparable enumerated set and already-prepared native manifests.
 * Charges, accepted-vector counters and transient producer scheduling are deliberately absent.
 */
export function compareSourceIndexProgress(before: SourceIndexProgressSnapshot,
  after: SourceIndexProgressSnapshot): SourceIndexProgressComparison {
  const unknown = (reason: string): SourceIndexProgressComparison => ({ status: "unknown", reason });
  const progress = (reason: string): SourceIndexProgressComparison => ({ status: "progress", reason });
  if (before.status !== "observed" || after.status !== "observed") return unknown("diagnostics_unavailable");
  const left = before.metadata!, right = after.metadata!;
  if ([...before.pending, ...after.pending].some(row => ["stale", "superseded", "unbound"].includes(row.result.status))) {
    return unknown("native_witness_refused");
  }
  if (!validMetadata(left) || !validMetadata(right)) return unknown("invalid_metadata_binding");
  if (left.workspace_id !== right.workspace_id || left.source_epoch !== right.source_epoch ||
      left.generation_id !== right.generation_id || canonicalJson(left.selection) !== canonicalJson(right.selection)) {
    return unknown("incomparable_binding");
  }
  const a = left.generation!, b = right.generation!;
  if (b.target_count < a.target_count || b.completed_count < a.completed_count ||
      a.enumeration_complete && !b.enumeration_complete ||
      a.after_source_id !== null && (b.after_source_id === null || b.after_source_id < a.after_source_id)) {
    return unknown("regressed_capture");
  }
  if (b.target_count > a.target_count || b.completed_count > a.completed_count ||
      !a.enumeration_complete && b.enumeration_complete ||
      b.after_source_id !== null && (a.after_source_id === null || b.after_source_id > a.after_source_id)) {
    return progress("persisted_capture_or_completion_advanced");
  }
  let prepared = true;
  for (const old of before.pending) {
    const next = after.pending.find(row => row.root_key === old.root_key);
    if (next === undefined) return unknown("captured_root_set_changed");
    if (old.result.status === "partial" && old.result.reason === "manifest_unprepared" && next.result.status === "ready") {
      return progress("manifest_prepared");
    }
    if (old.result.status !== "ready" || next.result.status !== "ready") { prepared = false; continue; }
    const a = old.result.ordinals[0], b = next.result.ordinals[0];
    if (a !== undefined && (b === undefined || b > a)) return progress("first_pending_window_advanced");
    if (a !== b) return unknown("pending_window_regressed");
  }
  if (!prepared) return unknown("native_manifest_or_pending_read_incomplete");
  const complete = (value: Metadata) => value.generation!.enumeration_complete &&
    value.targets.length === value.generation!.target_count && value.targets.length <= ROOT_LIMIT;
  if (!complete(left) || !complete(right) || before.pending.length !== left.targets.length ||
      after.pending.length !== right.targets.length) return unknown("captured_set_incomplete");
  if (canonicalJson(left) !== canonicalJson(right) || canonicalJson(before.pending) !== canonicalJson(after.pending)) {
    return unknown("native_witness_changed");
  }
  return { status: "no_progress", reason: "complete_prepared_native_witness_unchanged" };
}
