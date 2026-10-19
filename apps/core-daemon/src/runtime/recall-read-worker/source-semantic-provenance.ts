import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SourceRecordIdentity } from "@do-soul/alaya-protocol";
import { SourceIndexSnapshotFactSchema } from "./source-index-measurement.js";

const Count = z.number().finite().nonnegative();
const Origin = z.object({ session_id: z.string(), request_id: Count, object_id: z.string() }).strict();
type Origin = z.infer<typeof Origin>;
const Member = z.object({ record_id: z.string(), source_id: z.string(), source_version: z.string(), content_digest: z.string() }).strict();
const Union = z.object({ capture: z.enum(["complete", "overflow"]), source_count: Count,
  members: z.array(Member), source_discovery_open: z.boolean(), interpretation_discovery_open: z.boolean(),
  full_universe: z.literal("not_established") }).strict();
type Union = z.infer<typeof Union>;
const LeaseFact = z.object({ handle_digest: z.string(), kind: z.string(), origin: Origin.nullable(),
  pool_origin: Origin.nullable(), plan_origin: Origin.nullable() }).strict();
const Operation = z.object({ kind: z.enum(["retain", "canonical_scan"]), meter_id: Count.nullable(), phase: z.string(), reason: z.string(),
  count: Count, work: Count, bytes: Count, completed: Count, same_object_count: Count,
  same_object_work: Count, same_object_bytes: Count }).strict();
type Operation = z.infer<typeof Operation>;
const Encoding = z.object({ phase: z.string(), purpose: z.string(), encoder_invocations: Count, count: Count, utf8_bytes: Count,
  identical_complete_encodings: Count, repeated_component_bytes: Count, compared_components: Count }).strict();
type Encoding = z.infer<typeof Encoding>;

const BindingContext = z.object({ session_id: z.string(), request_id: Count, operation: z.string(), workspace_id: z.string(),
  as_of: z.string(), snapshot_revision: z.string().nullable(),
  preparation: z.object({ status: z.string(), reason: z.string().nullable() }).strict().nullable() }).strict();
type Binding = z.infer<typeof BindingContext> & { index: z.infer<typeof SourceIndexSnapshotFactSchema> | null };
const Binding: z.ZodType<Binding> = BindingContext.extend({ index: SourceIndexSnapshotFactSchema.nullable() });

/** Private native facts. Missing on historical frames means unobserved, never an empty union. */
export const SourceSemanticNativeFactsSchema = z.object({
  binding: Binding.nullable(),
  pool: z.object({ pool_id: z.string(), use: z.enum(["created", "reused"]), origin: Origin.nullable(), union: Union }).strict().nullable(),
  lease_reads: z.array(LeaseFact).max(32), lease_issues: z.array(LeaseFact).max(32),
  operations: z.array(Operation).max(128), encodings: z.array(Encoding).max(32),
  // Bounded diagnostic-detail completeness only; explicit null ancestry is still unknown.
  complete: z.boolean(), issues: z.array(z.string()).max(16)
}).strict();
export type SourceSemanticNativeFacts = z.infer<typeof SourceSemanticNativeFactsSchema>;
const SESSIONS = new WeakMap<object, string>();
const ORIGINS = new WeakMap<object, Origin>();
const PLAN_POOLS = new WeakMap<object, Origin | null>();
const digest = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

/** Weak object ancestry follows the real leases/pools. Equal query strings, pool labels or
 * request numbers from another runtime are not ancestry. No runtime or capability is cloned. */
export class SourceSemanticObservationFacts {
  private readonly value: SourceSemanticNativeFacts = { binding: null, pool: null, lease_reads: [], lease_issues: [],
    operations: [], encodings: [], complete: true, issues: [] };
  private readonly operations = new Map<string, Operation>();
  private readonly encodings = new Map<string, Encoding>();
  private readonly retained = new WeakSet<object>();
  private readonly scanned = new WeakSet<object>();
  private readonly encoded = new Set<string>();
  private readonly components = new Set<string>();
  constructor(private readonly requestId: number, private readonly maxBytes: number,
    private readonly safely: (work: () => void) => void) {}

  private overflow(issue: string): void {
    this.value.complete = false;
    if (!this.value.issues.includes(issue) && this.value.issues.length < 16) this.value.issues.push(issue);
  }
  private origin(object: object): Origin | null {
    const binding = this.value.binding;
    if (binding === null) return null;
    const origin = ORIGINS.get(object) ?? { session_id: binding.session_id, request_id: this.requestId, object_id: randomUUID() };
    ORIGINS.set(object, origin); return origin;
  }
  begin(runtime: object, binding: Omit<NonNullable<SourceSemanticNativeFacts["binding"]>, "session_id" | "request_id">): void {
    this.safely(() => {
      const session = SESSIONS.get(runtime) ?? randomUUID(); SESSIONS.set(runtime, session);
      this.value.binding = { ...binding, session_id: session, request_id: this.requestId };
    });
  }
  pool(pool: object, poolId: string, sources: readonly SourceRecordIdentity[],
    sourceOpen: boolean, interpretationOpen: boolean, use: "created" | "reused"): void {
    this.safely(() => {
      const members = sources.map(row => ({ record_id: row.identity, source_id: row.source_id,
        source_version: row.source_version, content_digest: row.content_digest }));
      const captured = Buffer.byteLength(JSON.stringify(members)) <= this.maxBytes / 2;
      const union: Union = { capture: captured ? "complete" : "overflow", source_count: sources.length,
        members: captured ? members : [], source_discovery_open: sourceOpen, interpretation_discovery_open: interpretationOpen,
        full_universe: "not_established" };
      if (!captured) this.overflow("candidate_union_detail_limit");
      // A reused pool first seen now has unknown creation ancestry, even though its finite membership is measurable.
      const origin = use === "created" ? this.origin(pool) : ORIGINS.get(pool) ?? null;
      this.value.pool = { pool_id: poolId, use, origin, union };
    });
  }
  plan(plan: object, pool: object): void {
    this.safely(() => { this.origin(plan); PLAN_POOLS.set(plan, ORIGINS.get(pool) ?? null); });
  }
  lease(action: "read" | "issue", id: string, lease: { kind: string; access_pool?: object; library_plan?: object }): void {
    this.safely(() => {
      const rows = action === "read" ? this.value.lease_reads : this.value.lease_issues;
      if (rows.length >= 32) { this.overflow("lease_fact_limit"); return; }
      const origin = action === "issue" ? this.origin(lease) : ORIGINS.get(lease) ?? null;
      const plan = lease.library_plan;
      rows.push({ handle_digest: digest(id), kind: lease.kind, origin,
        pool_origin: lease.access_pool === undefined ? plan === undefined ? null : PLAN_POOLS.get(plan) ?? null : ORIGINS.get(lease.access_pool) ?? null,
        plan_origin: plan === undefined ? null : ORIGINS.get(plan) ?? null });
    });
  }
  /** Same-object traversal is a proven repeated accounting proxy, not proof of duplicate
   * allocation or identical content. Partial traversals keep their actual charged deltas. */
  operation(kind: Operation["kind"], meterId: number | null, phase: string, reason: string, value: unknown,
    work: number, bytes: number, completed: boolean): void {
    this.safely(() => {
      const key = `${kind}\0${meterId}\0${phase}\0${reason}`;
      if (!this.operations.has(key) && this.operations.size >= 128) { this.overflow("operation_fact_limit"); return; }
      const seen = kind === "retain" ? this.retained : this.scanned;
      const object = value !== null && typeof value === "object" ? value : null;
      const repeated = object !== null && seen.has(object);
      if (object !== null) seen.add(object);
      const row = this.operations.get(key) ?? { kind, meter_id: meterId, phase, reason, count: 0, work: 0, bytes: 0,
        completed: 0, same_object_count: 0, same_object_work: 0, same_object_bytes: 0 };
      row.count++; row.work += work; row.bytes += bytes; row.completed += Number(completed);
      if (repeated) { row.same_object_count++; row.same_object_work += work; row.same_object_bytes += bytes; }
      this.operations.set(key, row);
    });
  }
  encodingInvocation(phase: string, purpose: string): void {
    this.safely(() => {
      const key = `${phase}\0${purpose}`;
      if (!this.encodings.has(key) && this.encodings.size >= 32) { this.overflow("encoding_fact_limit"); return; }
      const row = this.encodings.get(key) ?? { phase, purpose, encoder_invocations: 0, count: 0, utf8_bytes: 0,
        identical_complete_encodings: 0, repeated_component_bytes: 0, compared_components: 0 };
      row.encoder_invocations++; this.encodings.set(key, row);
    });
  }
  /** Called only with an ALREADY executed native encoding's JSON. Whole-envelope equality
   * proves duplicate encoding output; repeated preview bytes only prove component re-encoding. */
  encoding(phase: string, purpose: string, json: string, previews: readonly string[]): void {
    this.safely(() => {
      const key = `${phase}\0${purpose}`;
      if (!this.encodings.has(key) && this.encodings.size >= 32) { this.overflow("encoding_fact_limit"); return; }
      const row = this.encodings.get(key) ?? { phase, purpose, encoder_invocations: 0, count: 0, utf8_bytes: 0,
        identical_complete_encodings: 0, repeated_component_bytes: 0, compared_components: 0 };
      row.count++; row.utf8_bytes += Buffer.byteLength(json);
      const hash = digest(json);
      if (this.encoded.has(hash)) row.identical_complete_encodings++;
      else if (this.encoded.size < 256) this.encoded.add(hash);
      else this.overflow("encoding_identity_limit");
      for (const preview of previews) {
        const component = digest(preview); row.compared_components++;
        if (this.components.has(component)) row.repeated_component_bytes += Buffer.byteLength(preview);
        else if (this.components.size < 512) this.components.add(component);
        else this.overflow("encoding_component_limit");
      }
      this.encodings.set(key, row);
    });
  }
  finish(): SourceSemanticNativeFacts {
    return { ...this.value, operations: [...this.operations.values()], encodings: [...this.encodings.values()] };
  }
}
