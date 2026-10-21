import {
  SourceSemanticQueryPreparationSchema, SourceSemanticAcquisitionPhaseSchema,
  sourceSemanticAcquisitionNotRun, unavailableSourceQueryPreparation,
  type SourceSemanticQueryPreparation, type SourceSemanticAcquisitionPhase,
  type SourceSemanticAcquisition, type SourceSemanticPhaseAccounting, type SourceSemanticExecutionPhases as ExecutionPhases
} from "./source-semantic-phase-semantics.js";
import { PHASE_CODES as C, type SourceSemanticCompactPreparation, type SourceSemanticCompactAcquisition,
  type SourceSemanticAccessPhases, type SourceSemanticExecution, type CompactAcquisitionResult,
  type CompactLimitation } from "./source-semantic-phase-wire.js";
import { SourceSemanticResourceLedger } from "./source-semantic-resources.js";
import { SourceSemanticProfiledAcquisitionPhaseSchema, type SourceSemanticProfiledAcquisitionPhase,
  type SourceSemanticProfiledExecutionPhases } from "./source-semantic-access-profile.js";
import type { SourceSemanticProfiledCompactAcquisition, SourceSemanticProfiledExecution,
  SourceSemanticProfiledAccessPhases, SourceSemanticReadableAcquisition, SourceSemanticReadableExecution,
  SourceSemanticReadableAccessPhases } from "./source-semantic-phase-wire.js";
import { AlayaError } from "../shared/alaya-error.js";

type Meter = Pick<SourceSemanticResourceLedger, "charge" | "retain">;
const POLICY = "source-index-interleaved-prefix.v1" as const;
const CAPTURED = new WeakSet<object>();
function captured<T extends object>(value: T, meter?: Meter): T {
  meter?.charge(1, 16, "source phase capture ownership");
  CAPTURED.add(value);
  return value;
}

/** Semantic ingress is explicit and separate from packing and public wire admission. */
export function captureSourceSemanticQueryPreparation(value: unknown, meter?: Meter): SourceSemanticQueryPreparation {
  return captured(SourceSemanticResourceLedger.capture(value, value => SourceSemanticQueryPreparationSchema.parse(value),
    "source phase semantic preparation capture", meter), meter);
}
type AcquisitionPhase = SourceSemanticAcquisitionPhase | SourceSemanticProfiledAcquisitionPhase;
function requireLegacyAcquisition(value: SourceSemanticReadableAcquisition): asserts value is SourceSemanticCompactAcquisition {
  if (value[0] !== 1) throw new AlayaError("VALIDATION", "unsupported source acquisition version");
}
function parseAcquisition(value: unknown): AcquisitionPhase {
  // Capture first. Dispatch never validates one object and then reads a mutable caller reference.
  // Inspect only the own-key discriminator before capture, not caller-authored field values.
  // Keep the default's established Zod capture path and allocation unchanged.
  return value !== null && typeof value === "object" && Object.hasOwn(value, "declared_allowance")
    ? SourceSemanticProfiledAcquisitionPhaseSchema.parse(structuredClone(value)) : SourceSemanticAcquisitionPhaseSchema.parse(value);
}
export function captureSourceSemanticAcquisition(value: SourceSemanticProfiledAcquisitionPhase, meter?: Meter): SourceSemanticProfiledAcquisitionPhase;
export function captureSourceSemanticAcquisition<T extends Readonly<{ policy: "source-index-interleaved-prefix.v1";
  declared_allowance?: never }>>(value: T, meter?: Meter): SourceSemanticAcquisitionPhase;
export function captureSourceSemanticAcquisition(value: unknown, meter?: Meter): AcquisitionPhase;
export function captureSourceSemanticAcquisition(value: unknown, meter?: Meter): AcquisitionPhase {
  return captured(SourceSemanticResourceLedger.capture(value, parseAcquisition,
    "source phase semantic acquisition capture", meter), meter);
}

/** Exported internal-consumer ingress: hand off only the actual captured/packed pair.
 * Unlike public semantic capture, the direct call chain needs no CAPTURED entry. */
export function capturePackSourceSemanticPreparationForRequest(value: unknown, meter: Meter,
  consume: (capture: SourceSemanticQueryPreparation, compact: SourceSemanticCompactPreparation) => void): SourceSemanticCompactPreparation {
  const owned = SourceSemanticResourceLedger.capture(value, value => SourceSemanticQueryPreparationSchema.parse(value),
    "source phase semantic preparation capture", meter);
  traverse(owned, meter, "source phase preparation packing traversal");
  const compact = packPreparation(owned, meter);
  meter.retain(compact, "source phase packed preparation allocation", "immutable");
  consume(owned, compact);
  return compact;
}

export function capturePackSourceSemanticAcquisitionForRequest(value: unknown, meter: Meter,
  consume: (capture: SourceSemanticAcquisitionPhase, compact: SourceSemanticCompactAcquisition) => void): SourceSemanticCompactAcquisition {
  const owned = SourceSemanticResourceLedger.capture(value, value => SourceSemanticAcquisitionPhaseSchema.parse(value),
    "source phase acquisition packing capture", meter, "packing_intermediate");
  traverse(owned, meter, "source phase acquisition packing traversal");
  const compact = packAcquisition(owned, meter);
  meter.retain(compact, "source phase packed acquisition allocation", "immutable");
  consume(owned, compact);
  return compact;
}

/** Package-internal normal-form rule owned by this codec, not a caller assertion.
 * Expansion omits root supplemental when slot 3 is absent; nested retained leaves
 * (including their own undefined fields) are not reconstructed or normalized. */
export function sourceSemanticCanonicalPhaseCapture<T extends SourceSemanticQueryPreparation | AcquisitionPhase>(
  compact: SourceSemanticCompactPreparation | SourceSemanticReadableAcquisition, capture: T | undefined,
  meter: Pick<Meter, "charge">): T | undefined {
  meter.charge(2, 0, "source phase canonical capture eligibility");
  if (capture === undefined) return undefined;
  if (compact[0] === 2 && !("declared_allowance" in capture)) return undefined;
  if (compact[0] === 1 && compact[3] !== undefined) return capture;
  meter.charge(1, 0, "source phase canonical supplemental key check");
  return Object.hasOwn(capture, "supplemental") ? undefined : capture;
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
    // Map and table retain two references to the same immutable string, not another body.
    this.meter?.charge(1, 32 + 2 * 8, "source phase local index entry");
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

/** Pack captured route semantics for the v2 phase envelope without flattening hint costs or unknowns. */
export function packSourceSemanticQueryPreparation(value: SourceSemanticQueryPreparation, meter?: Meter): SourceSemanticCompactPreparation {
  const owned = CAPTURED.has(value) ? value : captureSourceSemanticQueryPreparation(value, meter);
  traverse(owned, meter, "source phase preparation packing traversal");
  const packed = packPreparation(owned, meter);
  meter?.retain(packed, "source phase packed preparation allocation", "immutable");
  return packed;
}
function packPreparation(value: SourceSemanticQueryPreparation, meter?: Meter): SourceSemanticCompactPreparation {
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
  const primary = [1, strings.table, body] as const;
  const route = value.supplemental?.[0];
  const hint = route === undefined ? undefined : packPreparation(route, meter);
  return hint === undefined ? primary : [...primary, [hint as NonNullable<SourceSemanticCompactPreparation[3]>[0]]];
}

function packResult(value: SourceSemanticAcquisition, strings: LocalStrings): CompactAcquisitionResult {
  const input = value.vector.input;
  const counts = value.accounting;
  const tuple = [counts.attempted, counts.admitted, counts.duplicate, counts.rejected, counts.scope_denied,
    counts.native_unknown, counts.resource_refused, counts.stale, counts.nomination_limit] as const;
  const tokenization = value.lexical.tokenization, state = value.vector.state;
  const vectorState: CompactAcquisitionResult[7][1] = state === null ? null : "binding" in state
    ? [strings.code(C.vector, state.status) as 0 | 1 | 2,
      state.binding]
    : [strings.code(C.vector, state.status) as 3 | 4 | 5, strings.ref(state.reason)];
  return [strings.nullable(value.navigation_digest), strings.code(C.completion, value.completion) as 0 | 1 | 2 | 3,
    value.nominations.map(row => [row.source,
      row.lexical.map(rank => [rank.rank, strings.code(C.lane, rank.lane) as 0 | 1, rank.lane_rank, rank.bm25]),
      row.vector === null ? null : [row.vector.rank, row.vector.cosine,
        row.vector.window]]),
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
export function packSourceSemanticAcquisition(value: SourceSemanticProfiledAcquisitionPhase, meter?: Meter): SourceSemanticProfiledCompactAcquisition;
export function packSourceSemanticAcquisition(value: SourceSemanticAcquisitionPhase, meter?: Meter): SourceSemanticCompactAcquisition;
export function packSourceSemanticAcquisition(value: AcquisitionPhase, meter?: Meter): SourceSemanticReadableAcquisition;
export function packSourceSemanticAcquisition(value: AcquisitionPhase, meter?: Meter): SourceSemanticReadableAcquisition {
  // The expanded copy is transient; packed retention owns every surviving leaf.
  const owned = CAPTURED.has(value) ? value : SourceSemanticResourceLedger.capture(value,
    parseAcquisition, "source phase acquisition packing capture", meter, "packing_intermediate");
  traverse(owned, meter, "source phase acquisition packing traversal");
  const packed = "declared_allowance" in owned ? packProfiledAcquisition(owned, meter) : packAcquisition(owned, meter);
  meter?.retain(packed, "source phase packed acquisition allocation", "immutable");
  return packed;
}
function packAcquisition(value: SourceSemanticAcquisitionPhase, meter?: Meter): SourceSemanticCompactAcquisition {
  const strings = new LocalStrings(meter);
  const primary = [1, strings.table,
    [strings.code(C.acquisition, value.status) as 0 | 1 | 2, strings.nullable(value.reason),
      [value.allowance.max_attempts, value.allowance.max_roots, value.allowance.max_vector_windows],
      [value.budget.work_units, value.budget.memory_bytes], value.result === null ? null : packResult(value.result, strings),
      strings.code(C.accounting, value.accounting) as 0 | 1 | 2]] as const;
  const route = value.supplemental?.[0];
  const hint = route === undefined ? undefined : packAcquisition(route, meter);
  return hint === undefined ? primary : [...primary, [hint as NonNullable<SourceSemanticCompactAcquisition[3]>[0]]];
}

function packProfiledAcquisition(value: SourceSemanticProfiledAcquisitionPhase, meter?: Meter): SourceSemanticProfiledCompactAcquisition {
  const strings = new LocalStrings(meter);
  return [2, strings.table, [value.policy, value.channels, value.declared_allowance,
    strings.code(C.acquisition, value.status) as 0 | 1 | 2, strings.nullable(value.reason), value.allowance,
    [value.budget.work_units, value.budget.memory_bytes], value.result,
    strings.code(C.accounting, value.accounting) as 0 | 1 | 2]];
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
    elapsed_ms: body[0] === 0 ? body[4] : body[11],
    ...(value[3] === undefined ? {} : { supplemental: [expandPreparation(value[3][0], meter)] })
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
function expandAcquisition(value: SourceSemanticCompactAcquisition, meter?: Meter): SourceSemanticAcquisitionPhase;
function expandAcquisition(value: SourceSemanticProfiledCompactAcquisition, meter?: Meter): SourceSemanticProfiledAcquisitionPhase;
function expandAcquisition(value: SourceSemanticReadableAcquisition, meter?: Meter): AcquisitionPhase;
function expandAcquisition(value: SourceSemanticReadableAcquisition, meter?: Meter): AcquisitionPhase {
  traverse(value, meter, "source phase acquisition expansion traversal");
  if (value[0] === 2) {
    const strings = new LocalReader(value[1], meter), body = value[2];
    const phase: SourceSemanticProfiledAcquisitionPhase = { policy: body[0], channels: body[1], declared_allowance: body[2],
      status: C.acquisition[body[3]], reason: strings.nullable(body[4]), allowance: body[5],
      budget: { work_units: body[6][0], memory_bytes: body[6][1] }, result: body[7], accounting: C.accounting[body[8]] };
    meter?.retain(phase, "source phase expanded acquisition allocation");
    return phase;
  }
  requireLegacyAcquisition(value);
  const strings = new LocalReader(value[1], meter), body = value[2];
  const phase: SourceSemanticAcquisitionPhase = { policy: POLICY, status: C.acquisition[body[0]], reason: strings.nullable(body[1]),
    allowance: { max_attempts: body[2][0], max_roots: body[2][1], max_vector_windows: body[2][2] },
    budget: { work_units: body[3][0], memory_bytes: body[3][1] }, result: body[4] === null ? null : expandResult(body[4], strings),
    accounting: C.accounting[body[5]],
    ...(value[3] === undefined ? {} : { supplemental: [expandAcquisition(value[3][0], meter)] }) };
  meter?.retain(phase, "source phase expanded acquisition allocation");
  return phase;
}

function nativePhases(): ExecutionPhases {
  return { contract: "source-semantic-execution-v3", semantic_generation_attempts: 0,
    query_preparation: unavailableSourceQueryPreparation("operation_does_not_prepare", "not_requested"),
    acquisition: sourceSemanticAcquisitionNotRun("operation_does_not_acquire") };
}
function compactPreparation(value: SourceSemanticQueryPreparation | SourceSemanticCompactPreparation, meter?: Meter): SourceSemanticCompactPreparation {
  return Array.isArray(value) ? value as SourceSemanticCompactPreparation
    : packSourceSemanticQueryPreparation(value as SourceSemanticQueryPreparation, meter);
}
function compactAcquisition(value: AcquisitionPhase | SourceSemanticReadableAcquisition, meter?: Meter): SourceSemanticReadableAcquisition {
  return Array.isArray(value) ? value as SourceSemanticReadableAcquisition
    : packSourceSemanticAcquisition(value as AcquisitionPhase, meter);
}

/** Exact checked-slot equality: native-only is never inferred from generation-attempt count alone. */
export function isNativeReasoningOnlyExecution(value: SourceSemanticReadableExecution, meter?: Meter): boolean {
  if (value === "native_reasoning_only") return true;
  // Candidate provenance cannot collapse to a literal that loses its contract family.
  if (value[2][0] === 2) return false;
  requireLegacyAcquisition(value[2]);
  if (value[1][3] !== undefined || value[2][3] !== undefined) return false;
  const p = value[1][2], a = value[2][2];
  meter?.charge(32, 0, "source phase canonical native equality");
  const preparation = p[1] === 3 && p[2] !== null && value[1][1][p[2]] === "operation_does_not_prepare" && p[3] === null
    && (p[0] === 0 ? p[4] === 0 : p[4] === null && p[5] === 0 && p[6] === 0 && p[7] === null && p[8] === 0
      && p[9] === 0 && p[10] === 0 && p[11] === 0);
  return preparation && a[0] === 1 && a[1] !== null && value[2][1][a[1]] === "operation_does_not_acquire"
    && a[2][0] === 0 && a[2][1] === 0 && a[2][2] === 0 && a[3][0] === 0 && a[3][1] === 0 && a[4] === null && a[5] === 2;
}
export function sourceSemanticExecution(preparation: SourceSemanticQueryPreparation | SourceSemanticCompactPreparation | undefined,
  acquisition: SourceSemanticProfiledAcquisitionPhase | SourceSemanticProfiledCompactAcquisition, meter?: Meter): SourceSemanticProfiledExecution;
export function sourceSemanticExecution(preparation?: SourceSemanticQueryPreparation | SourceSemanticCompactPreparation,
  acquisition?: SourceSemanticAcquisitionPhase | SourceSemanticCompactAcquisition, meter?: Meter): SourceSemanticExecution;
export function sourceSemanticExecution(preparation: SourceSemanticQueryPreparation | SourceSemanticCompactPreparation | undefined,
  acquisition: AcquisitionPhase | SourceSemanticReadableAcquisition | undefined, meter?: Meter): SourceSemanticReadableExecution;
export function sourceSemanticExecution(preparation?: SourceSemanticQueryPreparation | SourceSemanticCompactPreparation,
  acquisition?: AcquisitionPhase | SourceSemanticReadableAcquisition, meter?: Meter): SourceSemanticReadableExecution {
  if (preparation === undefined && acquisition === undefined) return "native_reasoning_only";
  // Defaults are authored by the semantic constructors, not untrusted ingress.
  const value = [2, preparation === undefined
    ? packSourceSemanticQueryPreparation(unavailableSourceQueryPreparation("operation_does_not_prepare", "not_requested"), meter)
    : compactPreparation(preparation, meter), acquisition === undefined
    ? packSourceSemanticAcquisition(sourceSemanticAcquisitionNotRun("operation_does_not_acquire"), meter)
    : compactAcquisition(acquisition, meter)] as const;
  meter?.charge(1, 24, "source phase execution tuple allocation");
  return isNativeReasoningOnlyExecution(value, meter) ? "native_reasoning_only" : value;
}
/** Explicit tooling/read authority; budgeted callers must pass their own meter. */
export function sourceSemanticExecutionPhases(value: SourceSemanticExecution, meter?: Meter): ExecutionPhases;
export function sourceSemanticExecutionPhases(value: SourceSemanticProfiledExecution, meter?: Meter): ExecutionPhases | SourceSemanticProfiledExecutionPhases;
export function sourceSemanticExecutionPhases(value: SourceSemanticReadableExecution, meter?: Meter): ExecutionPhases | SourceSemanticProfiledExecutionPhases;
export function sourceSemanticExecutionPhases(value: SourceSemanticReadableExecution, meter?: Meter): ExecutionPhases | SourceSemanticProfiledExecutionPhases {
  if (value === "native_reasoning_only") {
    const phases = nativePhases(); meter?.retain(phases, "source phase native execution expansion"); return phases;
  }
  meter?.charge(5, 64 + 4 * 8 + 4 * 24 + 4 * (8 + 28 + 17 + 11), "source phase expanded execution framing");
  const query_preparation = expandPreparation(value[1], meter);
  return value[2][0] === 2 ? { contract: "source-semantic-execution-v4", semantic_generation_attempts: 0,
    query_preparation, acquisition: expandAcquisition(value[2], meter) }
    : { contract: "source-semantic-execution-v3", semantic_generation_attempts: 0,
      query_preparation, acquisition: expandAcquisition(value[2], meter) };
}
type AccessExpansion<A> = Readonly<{ preparation: SourceSemanticQueryPreparation; acquisition: A; phase_accounting: SourceSemanticPhaseAccounting }>;
export function sourceSemanticAccessPhases(access: Readonly<{ phases: SourceSemanticAccessPhases }>, meter?: Meter): AccessExpansion<SourceSemanticAcquisitionPhase>;
export function sourceSemanticAccessPhases(access: Readonly<{ phases: SourceSemanticProfiledAccessPhases }>, meter?: Meter): AccessExpansion<SourceSemanticProfiledAcquisitionPhase>;
export function sourceSemanticAccessPhases(access: Readonly<{ phases: SourceSemanticReadableAccessPhases }>, meter?: Meter): AccessExpansion<AcquisitionPhase>;
export function sourceSemanticAccessPhases(access: Readonly<{ phases: SourceSemanticReadableAccessPhases }>, meter?: Meter): AccessExpansion<AcquisitionPhase> {
  return sourceSemanticAccessPhasesWithCaptures(access, meter);
}

/** Package-internal adapter seam; public decoding always expands both phases. */
export function sourceSemanticAccessPhasesWithCaptures(access: Readonly<{ phases: SourceSemanticAccessPhases }>, meter?: Meter,
  preparation?: SourceSemanticQueryPreparation, acquisition?: SourceSemanticAcquisitionPhase): AccessExpansion<SourceSemanticAcquisitionPhase>;
export function sourceSemanticAccessPhasesWithCaptures(access: Readonly<{ phases: SourceSemanticReadableAccessPhases }>, meter?: Meter,
  preparation?: SourceSemanticQueryPreparation, acquisition?: AcquisitionPhase): AccessExpansion<AcquisitionPhase>;
export function sourceSemanticAccessPhasesWithCaptures(access: Readonly<{ phases: SourceSemanticReadableAccessPhases }>, meter?: Meter,
  preparation?: SourceSemanticQueryPreparation, acquisition?: AcquisitionPhase): AccessExpansion<AcquisitionPhase> {
  meter?.charge(5, 64 + 3 * 8 + 3 * 24 + 4 * (11 + 11 + 16), "source phase expanded access framing");
  const observation = access.phases[3];
  const phase_accounting: SourceSemanticPhaseAccounting = { observation: observation === null ? null : {
    work: observation[0], memory_bytes: observation[1], native_bytes: observation[2], sql_internal_work: "unknown" },
    completion: "included_in_worker_work_not_separately_measured", native_cpu: "unknown", deadline: "soft_quarantine_until_exit" };
  meter?.retain(phase_accounting, "source phase observation expansion");
  return { preparation: preparation ?? expandPreparation(access.phases[1], meter),
    acquisition: acquisition ?? expandAcquisition(access.phases[2], meter), phase_accounting };
}
/** Narrow readers preserve null without allocating or expanding complete phases. */
export function sourceSemanticExecutionExternalAttempts(value: SourceSemanticReadableExecution): number | null {
  if (value === "native_reasoning_only") return 0;
  const preparation = value[1], primary = preparation[2][0] === 0 ? 0 : preparation[2][8];
  const hint = preparation[3]?.[0][2], supplemental = hint === undefined || hint[0] === 0 ? 0 : hint[8];
  return primary === null || supplemental === null ? null : primary + supplemental;
}
export function sourceSemanticPreparationReason(value: SourceSemanticCompactPreparation, meter?: Meter): string | null {
  meter?.charge(2, 0, "source phase preparation reason reference");
  return value[2][2] === null ? null : value[1][value[2][2]]!;
}
const ZERO_RESOURCES = [0, 0, 0] as const;
export function sourceSemanticAcquisitionResources(value: SourceSemanticReadableAcquisition, meter?: Meter): readonly [number, number, number] | null {
  meter?.charge(5, 0, "source phase acquisition resource slots");
  if (value[0] === 2) {
    const body = value[2];
    if (body[8] === 1) return null;
    const result = body[7];
    if (result === null) return body[3] === 1 && body[8] === 2 ? ZERO_RESOURCES : null;
    meter?.charge(3, 24, "source phase resource tuple");
    return [result.resources.work, result.resources.memory_bytes, result.resources.native_bytes];
  }
  requireLegacyAcquisition(value);
  const resources = (route: SourceSemanticCompactAcquisition): readonly [number, number, number] | null =>
    route[2][5] === 1 ? null : route[2][4]?.[4] ?? (route[2][0] === 1 && route[2][5] === 2 ? ZERO_RESOURCES : null);
  const primary = resources(value), hint = value[3]?.[0];
  if (hint === undefined) return primary;
  const supplemental = resources(hint);
  if (primary === null || supplemental === null) return null;
  meter?.charge(3, 24, "source phase aggregate resource tuple");
  return [primary[0] + supplemental[0], primary[1] + supplemental[1], primary[2] + supplemental[2]];
}
