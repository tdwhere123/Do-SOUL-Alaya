import { SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE, sourceSemanticAcquisitionNotRun, unavailableSourceQueryPreparation,
  captureSourceSemanticQueryPreparation, captureSourceSemanticAcquisition, packSourceSemanticQueryPreparation, packSourceSemanticAcquisition,
  type SourceSemanticCompactPreparation, type SourceSemanticCompactAcquisition, type SourceSemanticAcquisitionPhase, SourceSemanticResourceLedger,
  canonicalJsonChunks, sourceSemanticAccessPhases, sourceSemanticAcquisitionResources,
  prepareSourceSemanticCanonicalSubtreesForRequest, type PreparedSourceSemanticCanonicalSubtrees,
  type SourceSemanticAccessPolicy, type SourceSemanticAccessReceipt, type SourceSemanticPreviewExtents } from "@do-soul/alaya-protocol";
import { fieldContractSha256Chunks, quoteFieldContractSha256Chunks } from "@do-soul/alaya-core";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import { sourceSemanticRevision } from "./source-semantic-leases.js";

type Stops = SourceSemanticAccessReceipt["stopping_reasons"];
export type AccessReceiptPhases = Readonly<{
  preparation: SourceSemanticCompactPreparation; acquisition: SourceSemanticCompactAcquisition;
  observation: readonly [number, number, number] | null;
}>;
type Pageable = Readonly<{
  observed_source_count: number; observed_interpretation_count: number;
  source_candidates: readonly unknown[]; interpretation_candidates: readonly unknown[];
}>;

/** The final observation tuple has the same framing in execution and completion quotes. */
export function sourceSemanticObservationAccounting(acquisition: SourceSemanticCompactAcquisition,
  observed: Pick<SourceSemanticReadBudget, "spentWork" | "spentBytes" | "nativeBytes">,
  meter: SourceSemanticResourceLedger): AccessReceiptPhases["observation"] {
  const index = sourceSemanticAcquisitionResources(acquisition, meter);
  meter.charge(1, 24, "source phase observation tuple allocation");
  return index === null ? null : [observed.spentWork - index[0], observed.spentBytes - index[1], observed.nativeBytes - index[2]];
}

type IdentityMeter = Pick<SourceSemanticResourceLedger, "charge">;
type IdentityReceipt = { phases: SourceSemanticAccessReceipt["phases"] };
export type SourceSemanticIdentityCaptures = Readonly<{
  borrowPreparation?: Parameters<typeof prepareSourceSemanticCanonicalSubtreesForRequest>[1];
  acquisitionCapture?: SourceSemanticAcquisitionPhase;
}>;
const noCapture = () => undefined;

/** One expanded preimage owner for execution and completion quotes. */
function accessPoolIdentityMaterial(runtime: SourceSemanticReadRuntime, workspace: string,
  authorized: readonly string[] | null, receipt: IdentityReceipt, meter: IdentityMeter,
  prepared?: PreparedSourceSemanticCanonicalSubtrees) {
  // Bind expanded original/supplemental meaning before adding pool_id or a trace.
  const { phases: _phases, ...fields } = receipt;
  const phaseMeter = {
    charge: (work: number, bytes: number, phase?: string) => meter.charge(work, bytes, phase),
    retain: (value: unknown, phase?: string) => retainPhaseFrames(value, meter, phase)
  };
  const expanded = { ...fields, ...(prepared === undefined ? sourceSemanticAccessPhases(receipt, phaseMeter)
    : prepared.accessPhases(receipt, phaseMeter)) };
  meter.charge(4, 512 + Object.keys(expanded).length * 24 + 32, "source access identity frames");
  return { receipt: expanded, workspace, authorized, revision: sourceSemanticRevision(runtime) };
}

export function bindAccessPoolIdentity<Receipt extends IdentityReceipt>(runtime: SourceSemanticReadRuntime,
  workspace: string, authorized: readonly string[] | null, receipt: Receipt, meter: SourceSemanticReadBudget,
  prepared?: PreparedSourceSemanticCanonicalSubtrees): Receipt & { pool_id: string } {
  try {
    const material = accessPoolIdentityMaterial(runtime, workspace, authorized, receipt, meter, prepared);
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
  const borrowAcquisition = (expected: SourceSemanticCompactAcquisition) => expected === compact ? acquisition : undefined;
  const prepared = prepareSourceSemanticCanonicalSubtreesForRequest(receipt.phases,
    captures?.borrowPreparation ?? noCapture, borrowAcquisition, planning);
  try {
    const execution = new SourceSemanticResourceLedger(planning.remaining());
    const material = accessPoolIdentityMaterial(runtime, workspace, authorized, receipt, {
      charge(work, bytes, phase) { planning.charge(work, bytes, phase); execution.charge(work, bytes, phase); }
    }, prepared);
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

/** Construct compact provenance before any pool, completion quote or lease retains it. */
export function sourceSemanticAccessReceiptValue<Source, Interpretation, Unvisited>(meter: SourceSemanticResourceLedger,
  policy: SourceSemanticAccessPolicy, inputId: string, sources: readonly Source[], interpretations: readonly Interpretation[],
  unvisitedSources: Unvisited, unvisitedInterpretations: Unvisited, stops: Stops,
  sourcePreviewExtents?: SourceSemanticPreviewExtents, phases?: AccessReceiptPhases) {
  const preparation = phases?.preparation ?? packSourceSemanticQueryPreparation(captureSourceSemanticQueryPreparation(
    unavailableSourceQueryPreparation("controlled_or_scoped_access", "not_requested"), meter), meter);
  const acquisition = phases?.acquisition ?? packSourceSemanticAcquisition(captureSourceSemanticAcquisition(
    sourceSemanticAcquisitionNotRun("controlled_or_scoped_access"), meter), meter);
  meter.charge(1, 32, "source phase access tuple allocation");
  return { contract: "source-semantic-access-v2" as const,
    phases: [2, preparation, acquisition, phases?.observation ?? null] as const,
    policy, input_id: inputId,
    ...(sourcePreviewExtents === undefined ? {} : { source_preview_extents: sourcePreviewExtents }),
    observed_source_count: sources.length, observed_interpretation_count: interpretations.length,
    source_candidates: sources, interpretation_candidates: interpretations,
    unvisited_sources: unvisitedSources, unvisited_interpretations: unvisitedInterpretations,
    stopping_reasons: stops };
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
