import { randomUUID } from "node:crypto";
import { canonicalJson, type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { CoreError } from "@do-soul/alaya-core";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";

export type SourceSemanticLease = Readonly<{
  kind: "source" | "query" | "page";
  workspace_id: string; principal: string; as_of: string; authorized: readonly string[] | null;
  expires_at: string; revision: string;
  source_id?: string; source_version?: string; content_digest?: string;
  original_query?: string; q?: SourceSemanticQuery; q_id?: string;
  candidates?: readonly string[];
  after_cursor?: string | null; discovery_open?: boolean; truncated?: boolean;
}>;
type Caller = Readonly<{ workspace_id: string; principal?: string; as_of: string }>;
const LEASES = new WeakMap<RecallReadWorkerRuntime, Map<string, SourceSemanticLease>>();
const MAX_BYTES = 8_000_000;

export function sourceSemanticRevision(runtime: RecallReadWorkerRuntime): string {
  return String(runtime.database.connection.pragma("data_version", { simple: true }));
}

export function issueSemanticLease(runtime: RecallReadWorkerRuntime, lease: SourceSemanticLease, meter: SourceSemanticReadBudget): string {
  meter.retain(lease, "preparation lease");
  let rows = LEASES.get(runtime);
  if (rows === undefined) { rows = new Map(); LEASES.set(runtime, rows); }
  for (const [id, row] of rows) if (row.expires_at <= lease.as_of) rows.delete(id);
  const id = randomUUID(); rows.set(id, lease);
  const size = () => [...rows.values()].reduce((sum, row) => sum + 4 * canonicalJson(row).length, 0);
  while (rows.size > 32 || size() > MAX_BYTES) rows.delete(rows.keys().next().value!);
  if (!rows.has(id)) throw new CoreError("CONFLICT", "source semantic preparation exceeds lease capacity", { subCode: "RETRYABLE_BACKPRESSURE" });
  return id;
}

export function readSemanticLease(runtime: RecallReadWorkerRuntime, caller: Caller, id: string,
  authorized: readonly string[] | null, kind: SourceSemanticLease["kind"]): SourceSemanticLease {
  const rows = LEASES.get(runtime), lease = rows?.get(id);
  if (lease === undefined || lease.expires_at <= caller.as_of) {
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

export function semanticLeaseExpiry(asOf: string, requested?: string): string {
  const maximum = new Date(Date.parse(asOf) + 600_000).toISOString();
  return requested !== undefined && requested < maximum ? requested : maximum;
}
