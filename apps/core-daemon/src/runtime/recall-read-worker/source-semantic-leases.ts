import { randomUUID } from "node:crypto";
import { canonicalJson, type SourceSemanticQuery, type Continuation } from "@do-soul/alaya-protocol";
import { CoreError } from "@do-soul/alaya-core";
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
  original_query?: string; query_semantics?: SourceSemanticQuery; query_semantics_id?: string;
  candidates?: readonly string[];
  access_pool?: SourceSemanticAccessPool; access_offset?: number; access_source_offset?: number; truncated?: boolean;
  continuation?: Continuation; request_identity?: string;
  library_plan?: LibraryDeliveryPlan;
}>;
type Clock = Readonly<{ as_of: string; lifetime_now?: string }>;
type Caller = Clock & Readonly<{ workspace_id: string; principal?: string }>;
const LEASES = new WeakMap<RecallReadWorkerRuntime, Map<string, { lease: SourceSemanticLease; bytes: number }>>();
const MAX_BYTES = 8_000_000;

/** Interpretation time may be frozen; capability lifetime must keep advancing. */
export function sourceSemanticLifetimeNow(clock: Clock): string {
  return clock.lifetime_now ?? clock.as_of;
}

export function sourceSemanticRevision(runtime: RecallReadWorkerRuntime): string {
  return `${String(runtime.database.connection.pragma("data_version", { simple: true }))}:${String(
    (runtime.database.connection.prepare("SELECT total_changes() AS n").get() as { n: number }).n)}`;
}

export function issueSemanticLease(runtime: RecallReadWorkerRuntime, lease: SourceSemanticLease, meter: SourceSemanticReadBudget, issuedId?: string): string {
  meter.retain(lease, "preparation lease");
  let rows = LEASES.get(runtime);
  if (rows === undefined) { rows = new Map(); LEASES.set(runtime, rows); }
  meter.charge(rows.size * 2, 0, "preparation lease retention accounting");
  for (const [id, row] of rows) if (row.lease.expires_at <= sourceSemanticLifetimeNow(lease)) rows.delete(id);
  const id = issuedId ?? randomUUID(); rows.set(id, { lease, bytes: 4 * canonicalJson(lease).length });
  let bytes = [...rows.values()].reduce((sum, row) => sum + row.bytes, 0);
  while (rows.size > 32 || bytes > MAX_BYTES) {
    const oldest = rows.keys().next().value!;
    bytes -= rows.get(oldest)!.bytes; rows.delete(oldest);
  }
  if (!rows.has(id)) throw new CoreError("CONFLICT", "source semantic preparation exceeds lease capacity", { subCode: "RETRYABLE_BACKPRESSURE" });
  return id;
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
