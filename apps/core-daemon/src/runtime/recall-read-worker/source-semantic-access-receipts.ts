import { SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE, sourceSemanticAcquisitionNotRun, unavailableSourceQueryPreparation,
  captureSourceSemanticQueryPreparation, captureSourceSemanticAcquisition, packSourceSemanticQueryPreparation, packSourceSemanticAcquisition,
  type SourceSemanticCompactPreparation, type SourceSemanticCompactAcquisition, type SourceSemanticAcquisitionPhase, SourceSemanticResourceLedger,
  canonicalJsonChunks, sourceSemanticAccessPhases, sourceSemanticAcquisitionResources, sourceSemanticRetainedWitnessMatchesPhase,
  prepareSourceSemanticCanonicalSubtreesForRequest, type PreparedSourceSemanticCanonicalSubtrees,
  type SourceSemanticReadableAccessPhases, type SourceSemanticReadableAcquisition, type SourceSemanticAccessProfile,
  type SourceSemanticRetainedNominationWitness,
  type SourceSemanticAccessPolicy, type SourceSemanticAccessReceipt, type SourceSemanticReadableAccessReceipt, type SourceSemanticPreviewExtents } from "@do-soul/alaya-protocol";
import { fieldContractSha256Chunks, quoteFieldContractSha256Chunks } from "@do-soul/alaya-core";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import { sourceSemanticRevision } from "./source-semantic-leases.js";

type Stops = SourceSemanticAccessReceipt["stopping_reasons"];
export type AccessReceiptPhases<Acquisition extends SourceSemanticReadableAcquisition = SourceSemanticCompactAcquisition> = Readonly<{
  preparation: SourceSemanticCompactPreparation; acquisition: Acquisition;
  observation: readonly [number, number, number] | null;
}>;
type Pageable = Readonly<{
  observed_source_count: number; observed_interpretation_count: number;
  source_candidates: readonly unknown[]; interpretation_candidates: readonly unknown[];
}>;

/** The final observation tuple has the same framing in execution and completion quotes. */
export function sourceSemanticObservationAccounting(acquisition: SourceSemanticReadableAcquisition,
  observed: Pick<SourceSemanticReadBudget, "spentWork" | "spentBytes" | "nativeBytes">,
  meter: SourceSemanticResourceLedger): AccessReceiptPhases["observation"] {
  const index = sourceSemanticAcquisitionResources(acquisition, meter);
  meter.charge(1, 24, "source phase observation tuple allocation");
  return index === null ? null : [observed.spentWork - index[0], observed.spentBytes - index[1], observed.nativeBytes - index[2]];
}

type IdentityMeter = Pick<SourceSemanticResourceLedger, "charge">;
type IdentityReceipt = { phases: SourceSemanticReadableAccessPhases; contract?: string };
type PreparedIdentity = PreparedSourceSemanticCanonicalSubtrees<SourceSemanticReadableAccessPhases>;
export type SourceSemanticIdentityCaptures = Readonly<{
  borrowPreparation?: Parameters<typeof prepareSourceSemanticCanonicalSubtreesForRequest>[1];
  acquisitionCapture?: SourceSemanticAcquisitionPhase;
  retainedWitness?: SourceSemanticRetainedNominationWitness;
}>;
const noCapture = () => undefined;

/** One expanded preimage owner for execution and completion quotes. */
function accessPoolIdentityMaterial(runtime: SourceSemanticReadRuntime, workspace: string,
  authorized: readonly string[] | null, receipt: IdentityReceipt, meter: IdentityMeter,
  prepared?: PreparedIdentity, retainedWitness?: SourceSemanticRetainedNominationWitness) {
  // Bind expanded original/supplemental meaning before adding pool_id or a trace.
  const { phases: _phases, ...fields } = receipt;
  const phaseMeter = {
    charge: (work: number, bytes: number, phase?: string) => meter.charge(work, bytes, phase),
    retain: (value: unknown, phase?: string) => retainPhaseFrames(value, meter, phase)
  };
  if (receipt.contract === "source-semantic-access-v3" && retainedWitness === undefined) {
    throw new TypeError("candidate pool identity requires the full producer witness");
  }
  const expanded = { ...fields, ...(prepared === undefined ? sourceSemanticAccessPhases(receipt, phaseMeter)
    : prepared.accessPhases(receipt, phaseMeter)) };
  if (receipt.contract === "source-semantic-access-v3" && (!("declared_allowance" in expanded.acquisition) ||
      !sourceSemanticRetainedWitnessMatchesPhase(retainedWitness!, expanded.acquisition, meter))) {
    throw new TypeError("candidate full witness contradicts its acquisition projection");
  }
  meter.charge(4, 512 + Object.keys(expanded).length * 24 + 32, "source access identity frames");
  return { receipt: expanded, workspace, authorized, revision: sourceSemanticRevision(runtime),
    ...(receipt.contract === "source-semantic-access-v3" ? { retained_witness: retainedWitness } : {}) };
}

export function bindAccessPoolIdentity<Receipt extends IdentityReceipt>(runtime: SourceSemanticReadRuntime,
  workspace: string, authorized: readonly string[] | null, receipt: Receipt, meter: SourceSemanticReadBudget,
  prepared?: PreparedIdentity, retainedWitness?: SourceSemanticRetainedNominationWitness): Receipt & { pool_id: string } {
  try {
    const material = accessPoolIdentityMaterial(runtime, workspace, authorized, receipt, meter, prepared, retainedWitness);
    return { ...receipt, pool_id: `sha256:${fieldContractSha256Chunks(prepared === undefined
      ? canonicalJsonChunks(material, meter) : prepared.chunks(material, meter), meter)}` };
  } finally { prepared?.close(); }
}

/** Prepare only at the post-census identity seam. Instruction storage/first structure
 * belong to planning alone; execution still owes replay, scalar encoding and hashing.
 * Unowned/non-equivalent phases retain ordinary expansion and canonical costs. */
export function quoteAccessPoolIdentity(runtime: SourceSemanticReadRuntime, workspace: string,
  authorized: readonly string[] | null, receipt: IdentityReceipt, planning: SourceSemanticReadBudget,
  captures?: SourceSemanticIdentityCaptures) {
  planning.charge(1, 64, "source access identity quotation frames");
  // Snapshot only the actual codec pair, never a mutable caller/input wrapper.
  // Allocate after capacity preflight, charging before creation even on failure.
  planning.charge(1, 128, "source phase acquisition borrower callback");
  const acquisition = captures?.acquisitionCapture, compact = receipt.phases[2];
  const borrowAcquisition = (expected: SourceSemanticReadableAcquisition) => expected === compact && expected[0] === 1 ? acquisition : undefined;
  const prepared = prepareSourceSemanticCanonicalSubtreesForRequest(receipt.phases,
    captures?.borrowPreparation ?? noCapture, borrowAcquisition, planning);
  try {
    const execution = new SourceSemanticResourceLedger(planning.remaining());
    const material = accessPoolIdentityMaterial(runtime, workspace, authorized, receipt, {
      charge(work, bytes, phase) { planning.charge(work, bytes, phase); execution.charge(work, bytes, phase); }
    }, prepared, captures?.retainedWitness);
    quoteFieldContractSha256Chunks(prepared.quote(material, execution, planning), execution, planning);
    return { work_units: execution.spentWork, memory_bytes: execution.spentBytes, prepared };
  } catch (error) { prepared.close(); throw error; }
}

/** Decoder strings are borrowed; only container frames and reference slots are allocated. */
function retainPhaseFrames(value: unknown, meter: IdentityMeter, phase?: string): void {
  const pending = [value];
  meter.charge(0, 8, phase);
  while (pending.length) {
    const row = pending.pop();
    meter.charge(1, 0, phase);
    if (row === null || typeof row !== "object") continue;
    const values = Array.isArray(row) ? row : Object.values(row);
    meter.charge(1, Array.isArray(row) ? 64 + values.length * 16 : 128 + values.length * 24, phase);
    for (const child of values) pending.push(child);
  }
}

type AccessValue<S, I, U, Access extends SourceSemanticReadableAccessReceipt> =
  Omit<Access, "pool_id" | "trace" | "source_candidates" | "interpretation_candidates" | "unvisited_sources" | "unvisited_interpretations"> & {
    source_candidates: readonly S[]; interpretation_candidates: readonly I[]; unvisited_sources: U; unvisited_interpretations: U;
  };
/** Construct compact provenance before any pool, completion quote or lease retains it. */
export function sourceSemanticAccessReceiptValue<S, I, U>(meter: SourceSemanticResourceLedger,
  policy: SourceSemanticAccessPolicy, inputId: string, sources: readonly S[], interpretations: readonly I[],
  unvisitedSources: U, unvisitedInterpretations: U, stops: Stops, sourcePreviewExtents?: SourceSemanticPreviewExtents,
  phases?: AccessReceiptPhases): AccessValue<S, I, U, SourceSemanticAccessReceipt>;
export function sourceSemanticAccessReceiptValue<S, I, U>(meter: SourceSemanticResourceLedger,
  policy: SourceSemanticAccessPolicy, inputId: string, sources: readonly S[], interpretations: readonly I[],
  unvisitedSources: U, unvisitedInterpretations: U, stops: Stops, sourcePreviewExtents: SourceSemanticPreviewExtents | undefined,
  phases: AccessReceiptPhases<SourceSemanticReadableAcquisition> | undefined, candidateProfile: SourceSemanticAccessProfile | undefined):
  AccessValue<S, I, U, SourceSemanticAccessReceipt> | AccessValue<S, I, U, import("@do-soul/alaya-protocol").SourceSemanticProfiledAccessReceipt>;
export function sourceSemanticAccessReceiptValue<Source, Interpretation, Unvisited>(meter: SourceSemanticResourceLedger,
  policy: SourceSemanticAccessPolicy, inputId: string, sources: readonly Source[], interpretations: readonly Interpretation[],
  unvisitedSources: Unvisited, unvisitedInterpretations: Unvisited, stops: Stops,
  sourcePreviewExtents?: SourceSemanticPreviewExtents, phases?: AccessReceiptPhases<SourceSemanticReadableAcquisition>, candidateProfile?: SourceSemanticAccessProfile) {
  const preparation = phases?.preparation ?? packSourceSemanticQueryPreparation(captureSourceSemanticQueryPreparation(
    unavailableSourceQueryPreparation("controlled_or_scoped_access", "not_requested"), meter), meter);
  const acquisition = phases?.acquisition ?? packSourceSemanticAcquisition(captureSourceSemanticAcquisition(
    sourceSemanticAcquisitionNotRun("controlled_or_scoped_access"), meter), meter);
  meter.charge(1, 32, "source phase access tuple allocation");
  const fields = { input_id: inputId,
    ...(sourcePreviewExtents === undefined ? {} : { source_preview_extents: sourcePreviewExtents }),
    observed_source_count: sources.length, observed_interpretation_count: interpretations.length,
    source_candidates: sources, interpretation_candidates: interpretations,
    unvisited_sources: unvisitedSources, unvisited_interpretations: unvisitedInterpretations,
    stopping_reasons: stops };
  if (candidateProfile === undefined) {
    if (acquisition[0] !== 1) throw new TypeError("default access requires legacy acquisition");
    return { contract: "source-semantic-access-v2" as const,
      phases: [2, preparation, acquisition, phases?.observation ?? null] as const, policy, ...fields };
  }
  if (acquisition[0] !== 2) throw new TypeError("candidate access requires profiled acquisition");
  return { contract: "source-semantic-access-v3" as const, profile: candidateProfile,
    phases: [2, preparation, acquisition, phases?.observation ?? null] as const, ...fields };
}

/** The delivered preparation trace shape; page sizing can request the full bounded source pool. */
export function preparationAccessReceiptValue<Access extends Pageable>(pool: Readonly<{ access: Access }>, sourceOffset: number,
  interpretationOffset: number, interpretationCount: number,
  sourceCount: number = SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE) {
  const sourceRows = pool.access.source_candidates.slice(sourceOffset, sourceOffset + sourceCount);
  const interpretationRows = pool.access.interpretation_candidates.slice(interpretationOffset, interpretationOffset + interpretationCount);
  return { ...pool.access, source_candidates: sourceRows, interpretation_candidates: interpretationRows,
    trace: { kind: "preparation_page" as const, source_offset: sourceOffset, interpretation_offset: interpretationOffset,
      omitted_source_count: pool.access.observed_source_count - sourceRows.length,
      omitted_interpretation_count: pool.access.observed_interpretation_count - interpretationRows.length } };
}
