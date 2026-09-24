import { randomUUID } from "node:crypto";
import { canonicalJson, type SourceSemanticQuery, type SourceSemanticQueryStatus, type Continuation, type UtteranceAttribution } from "@do-soul/alaya-protocol";
import { CoreError, fieldContractSha256 } from "@do-soul/alaya-core";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { SourceSemanticAccessPool } from "./source-semantic-candidate-access.js";
import type { LibraryDeliveryPlan } from "./source-semantic-library-delivery.js";

export type SourceSemanticLease = Readonly<{
  kind: "source" | "query" | "page" | "library";
  workspace_id: string; principal: string; as_of: string; authorized: readonly string[] | null;
  lifetime_now?: string;
  expires_at: string; revision: string;
  source_id?: string; source_version?: string; content_digest?: string;
  attribution_context?: UtteranceAttribution;
  original_query?: string; query_semantics?: SourceSemanticQuery; query_semantics_id?: string;
  query_semantics_input_id?: string;
  query_semantics_status?: SourceSemanticQueryStatus;
  candidates?: readonly string[];
  access_pool?: SourceSemanticAccessPool; access_offset?: number; access_source_offset?: number; truncated?: boolean;
  continuation?: Continuation; request_identity?: string;
  library_plan?: LibraryDeliveryPlan;
}>;
type Clock = Readonly<{ as_of: string; lifetime_now?: string }>;
type Caller = Clock & Readonly<{ workspace_id: string; principal?: string }>;
type LeaseRow<Lease = SourceSemanticLease> = { lease: Lease; bytes: number };
const LEASES = new WeakMap<RecallReadWorkerRuntime, Map<string, LeaseRow>>();
const MAX_LEASES = 32;
const MAX_BYTES = 8_000_000;
export type QueryPreparationLeaseBase = Omit<SourceSemanticLease,
  "kind" | "candidates" | "truncated" | "access_pool" | "access_offset" | "access_source_offset">;

export function queryPreparationLease<Pool extends { descriptors: readonly { interpretation_id: string }[] },
  Offset extends number | string, Truncated extends boolean | string>(base: QueryPreparationLeaseBase, pool: Pool,
  accessOffset: Offset, sourceOffset: Offset, truncated: Truncated) {
  return { ...base, candidates: pool.descriptors.map((row) => row.interpretation_id), truncated,
    access_pool: pool, access_offset: accessOffset, access_source_offset: sourceOffset };
}

/** Bind the exact supplied object even when Core cannot admit it as Query Semantics. */
export function sourceSemanticQueryInputIdentity(query: SourceSemanticQuery | undefined): string | undefined {
  return query === undefined ? undefined : `sha256:${fieldContractSha256(canonicalJson(query))}`;
}

/** Interpretation time may be frozen; capability lifetime must keep advancing. */
export function sourceSemanticLifetimeNow(clock: Clock): string {
  return clock.lifetime_now ?? clock.as_of;
}

export function sourceSemanticRevision(runtime: RecallReadWorkerRuntime): string {
  return `${String(runtime.database.connection.pragma("data_version", { simple: true }))}:${String(
    (runtime.database.connection.prepare("SELECT total_changes() AS n").get() as { n: number }).n)}`;
}

export function issueSemanticLease(runtime: RecallReadWorkerRuntime, lease: SourceSemanticLease, meter: SourceSemanticReadBudget, issuedId?: string): string {
  return issueSemanticLeaseGroup(runtime, [{ lease, issuedId }], meter)[0]!;
}

/** Conservative work for a future group when the retained pool may be full. */
export function semanticLeaseGroupAccountingCost(count: number, retainedCount = MAX_LEASES): number {
  return count * retainedCount * 2 + count * (count - 1);
}

/** Capacity only: template leases are never installed or turned into capability identities. */
export function preflightSemanticLeaseGroup<Lease extends Clock & { expires_at: string }>(
  runtime: RecallReadWorkerRuntime, leases: readonly Lease[]): void {
  if (leases.length === 0) return;
  admittedRows(runtime, leases.map((lease) => ({ id: Symbol(), lease })), sourceSemanticLifetimeNow(leases[0]!));
}

/** Publish all handles in one response together; older leases remain evictable. */
export function issueSemanticLeaseGroup(runtime: RecallReadWorkerRuntime,
  issues: readonly Readonly<{ lease: SourceSemanticLease; issuedId?: string }>[], meter: SourceSemanticReadBudget): string[] {
  if (issues.length === 0) return [];
  const retained = LEASES.get(runtime);
  meter.charge(semanticLeaseGroupAccountingCost(issues.length, retained?.size ?? 0), 0,
    "preparation lease retention accounting");
  const ids: string[] = [];
  for (const { lease, issuedId } of issues) {
    meter.retain(lease, "preparation lease");
    ids.push(issuedId ?? randomUUID());
  }
  const protectedIds = new Set(ids);
  if (protectedIds.size !== ids.length) throw new CoreError("CONFLICT", "duplicate source semantic preparation handle");
  const rows = admittedRows(runtime, issues.map(({ lease }, index) => ({ id: ids[index]!, lease })),
    sourceSemanticLifetimeNow(issues[0]!.lease));
  LEASES.set(runtime, rows);
  return ids;
}

function admittedRows<K extends string | symbol, Lease extends { expires_at: string }>(runtime: RecallReadWorkerRuntime,
  issues: readonly Readonly<{ id: K; lease: Lease }>[], now: string): Map<string | K, LeaseRow<SourceSemanticLease | Lease>> {
  const rows = new Map<string | K, LeaseRow<SourceSemanticLease | Lease>>(LEASES.get(runtime));
  for (const [id, row] of rows) if (row.lease.expires_at <= now) rows.delete(id);
  for (const { id, lease } of issues) rows.set(id, { lease, bytes: 4 * canonicalJson(lease).length });
  const protectedIds = new Set<string | K>(issues.map((issue) => issue.id));
  let bytes = [...rows.values()].reduce((sum, row) => sum + row.bytes, 0);
  for (const id of rows.keys()) {
    if (rows.size <= MAX_LEASES && bytes <= MAX_BYTES) break;
    if (protectedIds.has(id)) continue;
    bytes -= rows.get(id)!.bytes; rows.delete(id);
  }
  if (rows.size > MAX_LEASES || bytes > MAX_BYTES) {
    throw new CoreError("CONFLICT", "source semantic preparation exceeds lease capacity", { subCode: "RETRYABLE_BACKPRESSURE" });
  }
  return rows;
}

export function readSemanticLease(runtime: RecallReadWorkerRuntime, caller: Caller, id: string,
  authorized: readonly string[] | null, kind: SourceSemanticLease["kind"]): SourceSemanticLease {
  const rows = LEASES.get(runtime), lease = rows?.get(id)?.lease;
  if (lease === undefined || lease.expires_at <= sourceSemanticLifetimeNow(caller)) {
    rows?.delete(id); throw new CoreError("VALIDATION", "source semantic preparation handle expired", { details: { admission: "expired" } });
  }
  if (lease.kind !== kind || lease.workspace_id !== caller.workspace_id || lease.principal !== (caller.principal ?? "")) {
    throw new CoreError("VALIDATION", "source semantic preparation handle is bound to another principal or operation", { details: { admission: "expired" } });
  }
  if (canonicalJson(lease.authorized) !== canonicalJson(authorized)) {
    throw new CoreError("VALIDATION", "preparation scope admission changed", { details: { admission: "expired" } });
  }
  if (kind !== "source" && lease.revision !== sourceSemanticRevision(runtime)) {
    rows?.delete(id); throw new CoreError("VALIDATION", "preparation snapshot is no longer current", { details: { admission: "filtered" } });
  }
  return lease;
}

export function semanticLeaseExpiry(lifetimeNow: string, requested?: string): string {
  const maximum = new Date(Date.parse(lifetimeNow) + 600_000).toISOString();
  return requested !== undefined && requested < maximum ? requested : maximum;
}
