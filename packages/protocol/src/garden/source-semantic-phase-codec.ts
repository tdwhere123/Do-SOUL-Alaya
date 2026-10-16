import {
  SourceSemanticQueryPreparationSchema, SourceSemanticAcquisitionPhaseSchema,
  sourceSemanticAcquisitionNotRun, unavailableSourceQueryPreparation, SourceSemanticVectorBindingSchema, SourceSemanticQueryWindowSchema,
  type SourceSemanticQueryPreparation, type SourceSemanticAcquisitionPhase,
  type SourceSemanticAcquisition, type SourceSemanticPhaseAccounting, type SourceSemanticExecutionPhases as ExecutionPhases
} from "./source-semantic-phase-semantics.js";
import { PHASE_CODES as C, type SourceSemanticCompactPreparation, type SourceSemanticCompactAcquisition,
  type SourceSemanticAccessPhases, type SourceSemanticExecution, type CompactAcquisitionResult,
  type CompactLimitation } from "./source-semantic-phase-wire.js";
import type { SourceSemanticResourceLedger } from "./source-semantic-resources.js";
import { AlayaError } from "../shared/alaya-error.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { SourceIndexTargetSchema } from "../recall/source-index.js";

type Meter = Pick<SourceSemanticResourceLedger, "charge" | "retain">;
const POLICY = "source-index-interleaved-prefix.v1" as const;

/** Semantic ingress is explicit and separate from packing and public wire admission. */
export function captureSourceSemanticQueryPreparation(value: unknown, meter?: Meter): SourceSemanticQueryPreparation {
  meter?.retain(value, "source phase semantic preparation capture");
  return SourceSemanticQueryPreparationSchema.parse(value);
}
export function captureSourceSemanticAcquisition(value: unknown, meter?: Meter): SourceSemanticAcquisitionPhase {
  meter?.retain(value, "source phase semantic acquisition capture");
  return SourceSemanticAcquisitionPhaseSchema.parse(value);
}

/** Traversal work and its pending references, without pretending to retain another expanded copy. */
function traverse(value: unknown, meter: Meter | undefined, phase: string): void {
  if (meter === undefined) return;
  const pending: unknown[] = [value];
  meter.charge(0, 8, phase);
  while (pending.length > 0) {
    const row = pending.pop(); meter.charge(1, 0, phase);
    if (row === null || typeof row !== "object") continue;
    const values = Array.isArray(row) ? row : Object.values(row);
    meter.charge(0, values.length * 8, phase);
    for (const item of values) pending.push(item);
  }
}
class LocalStrings {
  readonly table: string[] = [];
  private readonly indices = new Map<string, number>();
  constructor(private readonly meter?: Meter) { meter?.charge(1, 64, "source phase local index construction"); }
  code<const Values extends readonly string[]>(values: Values, value: Values[number]): number {
    for (let index = 0; index < values.length; index++) {
      this.meter?.charge(1, 0, "source phase enum code lookup");
      if (values[index] === value) return index;
    }
    throw new AlayaError("VALIDATION", "unknown source phase enum");
  }
  ref(value: string): number {
    this.meter?.charge(1 + value.length, 0, "source phase local index lookup");
    const prior = this.indices.get(value);
    if (prior !== undefined) return prior;
    this.meter?.charge(1, 32 + 4 * value.length, "source phase local index entry");
    const index = this.table.length; this.indices.set(value, index); this.table.push(value); return index;
  }
  nullable(value: string | null): number | null { return value === null ? null : this.ref(value); }
  limitations(values: readonly string[]): CompactLimitation[] {
    return values.map(value => {
      this.meter?.charge(C.limitation.length, 0, "source phase limitation code lookup");
      const known = C.limitation.indexOf(value as typeof C.limitation[number]);
      return known < 0 ? [this.ref(value)] : known as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
    });
  }
}

/** Pack only captured semantics. Version 1 never drops profile identity or unknown measurements. */
export function packSourceSemanticQueryPreparation(value: SourceSemanticQueryPreparation, meter?: Meter): SourceSemanticCompactPreparation {
  traverse(value, meter, "source phase preparation packing traversal");
  const strings = new LocalStrings(meter), status = strings.code(C.preparation, value.status) as 0 | 1 | 2 | 3;
  const reason = strings.nullable(value.reason), navigation = strings.nullable(value.navigation_digest);
  const short = value.selected === null && value.method === "not_run" && value.submitted_inputs === 0
    && value.token_count === null && value.external_api_attempts === 0
    && value.binding_work === "not_run" && value.execution_work === "not_run";
  const body: SourceSemanticCompactPreparation[2] = short ? [0, status, reason, navigation, value.elapsed_ms]
    : [1, status, reason, navigation, value.selected === null ? null : [value.selected.selection_revision,
      strings.ref(value.selected.config_id), strings.ref(value.selected.profile_id), value.selected.profile],
    strings.code(C.method, value.method) as 0 | 1 | 2, value.submitted_inputs, value.token_count, value.external_api_attempts,
    strings.code(C.work, value.binding_work) as 0 | 1, strings.code(C.work, value.execution_work) as 0 | 1, value.elapsed_ms];
  const packed: SourceSemanticCompactPreparation = [1, strings.table, body];
  meter?.retain(packed, "source phase packed preparation allocation", "immutable");
  return packed;
}

function packResult(value: SourceSemanticAcquisition, strings: LocalStrings): CompactAcquisitionResult {
  const counts = value.accounting;
  const tuple = [counts.attempted, counts.admitted, counts.duplicate, counts.rejected, counts.scope_denied,
    counts.native_unknown, counts.resource_refused, counts.stale, counts.nomination_limit] as const;
  const tokenization = value.lexical.tokenization, state = value.vector.state, input = value.vector.input;
  const vectorState: CompactAcquisitionResult[7][1] = state === null ? null : "binding" in state
    ? [strings.code(C.vector, state.status) as 0 | 1 | 2, state.binding]
    : [strings.code(C.vector, state.status) as 3 | 4 | 5, strings.ref(state.reason)];
  return [strings.nullable(value.navigation_digest), strings.code(C.completion, value.completion) as 0 | 1 | 2 | 3,
    value.nominations.map(row => [row.source, row.lexical.map(rank => [rank.rank, strings.code(C.lane, rank.lane) as 0 | 1,
      rank.lane_rank, rank.bm25]), row.vector === null ? null : [row.vector.rank, row.vector.cosine, row.vector.window]]),
    tuple.every(count => count === 0) ? 0 : tuple,
    [value.resources.work, value.resources.memory_bytes, value.resources.native_bytes],
    value.resource_refusals.map(row => [strings.code(C.stage, row.stage) as 0 | 1 | 2 | 3 | 4, strings.ref(row.phase)]),
    [strings.code(C.completion, value.lexical.completion) as 0 | 1 | 2 | 3, strings.nullable(value.lexical.reason),
      strings.limitations(value.lexical.limitations), tokenization === null ? null : [strings.ref(tokenization.binding_digest),
        strings.code(C.cjk, tokenization.cjk_state) as 0 | 1 | 2 | 3, tokenization.terms.map(term => strings.ref(term)),
        tokenization.unicode61_terms.map(term => strings.ref(term)), tokenization.trigram_terms.map(term => strings.ref(term))]],
    [strings.code(C.completion, value.vector.completion) as 0 | 1 | 2 | 3, vectorState, strings.nullable(value.vector.reason),
      value.vector.inspected_windows, value.vector.invalid_windows, strings.code(C.validation, value.vector.validation) as 0 | 1 | 2 | 3,
      input.status === "available" ? [0, strings.ref(input.profile_id), strings.ref(input.input_digest)] : [1, strings.ref(input.reason)]],
    strings.limitations(value.limitations)];
}
export function packSourceSemanticAcquisition(value: SourceSemanticAcquisitionPhase, meter?: Meter): SourceSemanticCompactAcquisition {
  validateAcquisitionReferences(value, meter);
  traverse(value, meter, "source phase acquisition packing traversal");
  const strings = new LocalStrings(meter);
  const packed: SourceSemanticCompactAcquisition = [1, strings.table,
    [strings.code(C.acquisition, value.status) as 0 | 1 | 2, strings.nullable(value.reason),
      [value.allowance.max_attempts, value.allowance.max_roots, value.allowance.max_vector_windows],
      [value.budget.work_units, value.budget.memory_bytes], value.result === null ? null : packResult(value.result, strings),
      strings.code(C.accounting, value.accounting) as 0 | 1 | 2]];
  meter?.retain(packed, "source phase packed acquisition allocation", "immutable");
  return packed;
}

/** Native receipts forward repository/binder leaves; validate those before any lease can be issued. */
function validateAcquisitionReferences(value: SourceSemanticAcquisitionPhase, meter?: Meter): void {
  const result = value.result;
  if (result === null) return;
  const input = result.vector.input;
  if (input.status === "available") {
    meter?.charge(2, 0, "source phase vector digest admission");
    Sha256DigestSchema.parse(input.profile_id); Sha256DigestSchema.parse(input.input_digest);
  }
  const state = result.vector.state;
  if (state !== null && "binding" in state) {
    meter?.retain(state.binding, "source phase vector binding admission");
    SourceSemanticVectorBindingSchema.parse(state.binding);
  }
  for (const nomination of result.nominations) {
    meter?.retain(nomination.source, "source phase nomination target admission");
    SourceIndexTargetSchema.parse(nomination.source);
    if (nomination.vector !== null) {
      meter?.retain(nomination.vector.window, "source phase vector window admission");
      SourceSemanticQueryWindowSchema.parse(nomination.vector.window);
    }
  }
}

class LocalReader {
  constructor(private readonly table: readonly string[], private readonly meter?: Meter) {}
  ref(index: number): string {
    this.meter?.charge(1, 0, "source phase local reference expansion");
    const value = this.table[index];
    if (value === undefined) throw new AlayaError("VALIDATION", "source phase local reference out of bounds");
    return value;
  }
  nullable(index: number | null): string | null { return index === null ? null : this.ref(index); }
  limitations(values: readonly CompactLimitation[]): string[] {
    return values.map(value => typeof value === "number" ? C.limitation[value] : this.ref(value[0]));
  }
}
function expandPreparation(value: SourceSemanticCompactPreparation, meter?: Meter): SourceSemanticQueryPreparation {
  traverse(value, meter, "source phase preparation expansion traversal");
  const strings = new LocalReader(value[1], meter), body = value[2];
  const preparation: SourceSemanticQueryPreparation = {
    status: C.preparation[body[1]], reason: strings.nullable(body[2]), navigation_digest: strings.nullable(body[3]),
    selected: body[0] === 0 || body[4] === null ? null : { selection_revision: body[4][0],
      config_id: strings.ref(body[4][1]), profile_id: strings.ref(body[4][2]), profile: body[4][3] },
    method: body[0] === 0 ? "not_run" : C.method[body[5]], submitted_inputs: body[0] === 0 ? 0 : body[6],
    token_count: body[0] === 0 ? null : body[7], external_api_attempts: body[0] === 0 ? 0 : body[8],
    binding_work: body[0] === 0 ? "not_run" : C.work[body[9]], execution_work: body[0] === 0 ? "not_run" : C.work[body[10]],
    elapsed_ms: body[0] === 0 ? body[4] : body[11]
  };
  meter?.retain(preparation, "source phase expanded preparation allocation");
  return preparation;
}
function expandResult(value: CompactAcquisitionResult, strings: LocalReader): SourceSemanticAcquisition {
  const counts = value[3], lexical = value[6], vector = value[7], tokenization = lexical[3], state = vector[1], input = vector[6];
  const vectorState: SourceSemanticAcquisition["vector"]["state"] = state === null ? null
    : typeof state[1] === "number" ? { status: C.vector[state[0]] as "unknown" | "unbound" | "unavailable", reason: strings.ref(state[1]) }
      : { status: C.vector[state[0]] as "ready" | "partial" | "valid_empty", binding: state[1] };
  return { policy: POLICY, navigation_digest: strings.nullable(value[0]), completion: C.completion[value[1]],
    nominations: value[2].map(row => ({ source: row[0], lexical: row[1].map(rank => ({ rank: rank[0], lane: C.lane[rank[1]],
      lane_rank: rank[2], bm25: rank[3] })), vector: row[2] === null ? null : { rank: row[2][0], cosine: row[2][1], window: row[2][2] } })),
    accounting: { attempted: counts === 0 ? 0 : counts[0], admitted: counts === 0 ? 0 : counts[1], duplicate: counts === 0 ? 0 : counts[2],
      rejected: counts === 0 ? 0 : counts[3], scope_denied: counts === 0 ? 0 : counts[4], native_unknown: counts === 0 ? 0 : counts[5],
      resource_refused: counts === 0 ? 0 : counts[6], stale: counts === 0 ? 0 : counts[7], nomination_limit: counts === 0 ? 0 : counts[8] },
    resources: { work: value[4][0], memory_bytes: value[4][1], native_bytes: value[4][2], sql_internal_work: "unknown" },
    resource_refusals: value[5].map(row => ({ stage: C.stage[row[0]], phase: strings.ref(row[1]) })),
    lexical: { completion: C.completion[lexical[0]], index_coverage: "partial", reason: strings.nullable(lexical[1]),
      limitations: strings.limitations(lexical[2]), tokenization: tokenization === null ? null : { policy: "source-index-fts.v1",
        binding_digest: strings.ref(tokenization[0]), cjk_state: C.cjk[tokenization[1]], terms: tokenization[2].map(term => strings.ref(term)),
        unicode61_terms: tokenization[3].map(term => strings.ref(term)), trigram_terms: tokenization[4].map(term => strings.ref(term)) } },
    vector: { completion: C.completion[vector[0]], state: vectorState, reason: strings.nullable(vector[2]),
      inspected_windows: vector[3], invalid_windows: vector[4], validation: C.validation[vector[5]], ranking: "exact_over_inspected_subset",
      input: input[0] === 0 ? { status: "available", profile_id: strings.ref(input[1]), input_digest: strings.ref(input[2]) }
        : { status: "unavailable", reason: strings.ref(input[1]) } }, limitations: strings.limitations(value[8]) };
}
function expandAcquisition(value: SourceSemanticCompactAcquisition, meter?: Meter): SourceSemanticAcquisitionPhase {
  traverse(value, meter, "source phase acquisition expansion traversal");
  const strings = new LocalReader(value[1], meter), body = value[2];
  const phase: SourceSemanticAcquisitionPhase = { policy: POLICY, status: C.acquisition[body[0]], reason: strings.nullable(body[1]),
    allowance: { max_attempts: body[2][0], max_roots: body[2][1], max_vector_windows: body[2][2] },
    budget: { work_units: body[3][0], memory_bytes: body[3][1] }, result: body[4] === null ? null : expandResult(body[4], strings),
    accounting: C.accounting[body[5]] };
  meter?.retain(phase, "source phase expanded acquisition allocation");
  return phase;
}

function nativePhases(): ExecutionPhases {
  return { contract: "source-semantic-execution-v2", semantic_generation_attempts: 0,
    query_preparation: unavailableSourceQueryPreparation("operation_does_not_prepare", "not_requested"),
    acquisition: sourceSemanticAcquisitionNotRun("operation_does_not_acquire") };
}
function compactPreparation(value: SourceSemanticQueryPreparation | SourceSemanticCompactPreparation, meter?: Meter): SourceSemanticCompactPreparation {
  return Array.isArray(value) ? value as SourceSemanticCompactPreparation
    : packSourceSemanticQueryPreparation(captureSourceSemanticQueryPreparation(value, meter), meter);
}
function compactAcquisition(value: SourceSemanticAcquisitionPhase | SourceSemanticCompactAcquisition, meter?: Meter): SourceSemanticCompactAcquisition {
  return Array.isArray(value) ? value as SourceSemanticCompactAcquisition
    : packSourceSemanticAcquisition(captureSourceSemanticAcquisition(value, meter), meter);
}

/** Exact checked-slot equality: native-only is never inferred from generation-attempt count alone. */
export function isNativeReasoningOnlyExecution(value: SourceSemanticExecution, meter?: Meter): boolean {
  if (value === "native_reasoning_only") return true;
  const p = value[1][2], a = value[2][2];
  meter?.charge(32, 0, "source phase canonical native equality");
  const preparation = p[1] === 3 && p[2] !== null && value[1][1][p[2]] === "operation_does_not_prepare" && p[3] === null
    && (p[0] === 0 ? p[4] === 0 : p[4] === null && p[5] === 0 && p[6] === 0 && p[7] === null && p[8] === 0
      && p[9] === 0 && p[10] === 0 && p[11] === 0);
  return preparation && a[0] === 1 && a[1] !== null && value[2][1][a[1]] === "operation_does_not_acquire"
    && a[2][0] === 0 && a[2][1] === 0 && a[2][2] === 0 && a[3][0] === 0 && a[3][1] === 0 && a[4] === null && a[5] === 2;
}
export function sourceSemanticExecution(preparation?: SourceSemanticQueryPreparation | SourceSemanticCompactPreparation,
  acquisition?: SourceSemanticAcquisitionPhase | SourceSemanticCompactAcquisition, meter?: Meter): SourceSemanticExecution {
  if (preparation === undefined && acquisition === undefined) return "native_reasoning_only";
  // Defaults are authored by the semantic constructors, not untrusted ingress.
  const value = [1, preparation === undefined
    ? packSourceSemanticQueryPreparation(unavailableSourceQueryPreparation("operation_does_not_prepare", "not_requested"), meter)
    : compactPreparation(preparation, meter), acquisition === undefined
    ? packSourceSemanticAcquisition(sourceSemanticAcquisitionNotRun("operation_does_not_acquire"), meter)
    : compactAcquisition(acquisition, meter)] as const;
  meter?.charge(1, 24, "source phase execution tuple allocation");
  return isNativeReasoningOnlyExecution(value, meter) ? "native_reasoning_only" : value;
}
/** Explicit tooling/read authority; budgeted callers must pass their own meter. */
export function sourceSemanticExecutionPhases(value: SourceSemanticExecution, meter?: Meter): ExecutionPhases {
  if (value === "native_reasoning_only") {
    const phases = nativePhases(); meter?.retain(phases, "source phase native execution expansion"); return phases;
  }
  meter?.charge(5, 64 + 4 * 8 + 4 * 24 + 4 * (8 + 28 + 17 + 11), "source phase expanded execution framing");
  return { contract: "source-semantic-execution-v2", semantic_generation_attempts: 0,
    query_preparation: expandPreparation(value[1], meter), acquisition: expandAcquisition(value[2], meter) };
}
export function sourceSemanticAccessPhases(access: Readonly<{ phases: SourceSemanticAccessPhases }>, meter?: Meter): Readonly<{
  preparation: SourceSemanticQueryPreparation; acquisition: SourceSemanticAcquisitionPhase; phase_accounting: SourceSemanticPhaseAccounting }> {
  meter?.charge(5, 64 + 3 * 8 + 3 * 24 + 4 * (11 + 11 + 16), "source phase expanded access framing");
  const observation = access.phases[3];
  const phase_accounting: SourceSemanticPhaseAccounting = { observation: observation === null ? null : {
    work: observation[0], memory_bytes: observation[1], native_bytes: observation[2], sql_internal_work: "unknown" },
    completion: "included_in_worker_work_not_separately_measured", native_cpu: "unknown", deadline: "soft_quarantine_until_exit" };
  meter?.retain(phase_accounting, "source phase observation expansion");
  return { preparation: expandPreparation(access.phases[1], meter), acquisition: expandAcquisition(access.phases[2], meter), phase_accounting };
}
/** Narrow readers preserve null without allocating or expanding complete phases. */
export function sourceSemanticExecutionExternalAttempts(value: SourceSemanticExecution): number | null {
  return value === "native_reasoning_only" || value[1][2][0] === 0 ? 0 : value[1][2][8];
}
export function sourceSemanticPreparationReason(value: SourceSemanticCompactPreparation, meter?: Meter): string | null {
  meter?.charge(2, 0, "source phase preparation reason reference");
  return value[2][2] === null ? null : value[1][value[2][2]]!;
}
export function sourceSemanticAcquisitionResources(value: SourceSemanticCompactAcquisition, meter?: Meter): readonly [number, number, number] | null {
  meter?.charge(5, 0, "source phase acquisition resource slots");
  return value[2][4] === null ? null : value[2][4][4];
}
