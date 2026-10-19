import { indexEntryCacheKey, qualifySourceDisclosure, sourceSemanticExecution, SourceSemanticWorkerResultSchema,
  unavailableSourceQueryPreparation, type SourceSemanticExecution } from "@do-soul/alaya-protocol";
import { assembleSourceSemanticLibraryIndex, encodeSourceSemanticLibraryResponse, preparedDeliveryId, sealIssuedContinuation,
  selectSourceSemanticLibraryPage, slotQualifiersFor, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { physicalRoot, rawSourceTwin }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { measureNativeSubset, roomyDeliveryBytes, type NativeMeasurement, type NativeSubsetContext }
  from "./source-semantic-library-subset-packing.test-support.js";

const NATIVE = sourceSemanticExecution();
const ADMITTED = sourceSemanticExecution(unavailableSourceQueryPreparation("attestation_missing", "not_requested"));

function reservedWork(request: NativeMeasurement["request"]) {
  return { native_work: request.budget.work_units, index_work: request.budget.work_units,
    native_accounting: "partial" as const, logical_work: request.budget.work_units,
    native_bytes: request.budget.memory_bytes, logical_memory_bytes: request.budget.memory_bytes,
    rss_bytes: Number.MAX_SAFE_INTEGER };
}

/** Independent public-encoder oracle: both disclosures, reserved work, execution, continuation, truncation. */
function assembledMembershipEnvelope(context: NativeSubsetContext, measurement: NativeMeasurement,
  membership: readonly SourceSemanticLibraryPackage[], options: {
    more_roots: boolean; emitted_offset: number; truncated?: boolean; open_residuals?: boolean;
    payload?: "complete" | "truncated"; execution?: SourceSemanticExecution; disclose_time?: boolean;
  }) {
  const { plan, native, request } = measurement, proofs = membership.flatMap(row => row.proofs);
  const sourceIds = new Set(context.fixture.sources.filter(source =>
    membership.some(row => physicalRoot(row) === physicalRoot(source.package))).map(source => source.id));
  const sourceCandidates = context.pool.access.source_candidates.filter(row => sourceIds.has(row.source_id));
  const assembled = assembleSourceSemanticLibraryIndex({ query_id: plan.query_id, snapshot_id: plan.snapshot_id,
    interpretation_id: plan.interpretation_id, as_of: plan.as_of, expires_at: plan.expires_at,
    authorized_scopes: plan.authorized, source_entries: membership.map(row => row.entry),
    selected_entries: membership.map(row => row.entry), proof_groups: membership.filter(row => row.proofs.length > 0),
    root_order: membership.map(physicalRoot), truncated: options.truncated ?? plan.discovery.truncated,
    open_residuals: options.open_residuals ?? plan.discovery.open_residuals,
    more_roots: options.more_roots, emitted_offset: options.emitted_offset });
  const index = assembled.index.continuation === null ? assembled.index : {
    ...assembled.index, continuation: sealIssuedContinuation(assembled.index.continuation) };
  const material = SourceSemanticWorkerResultSchema.parse({
    ...native, execution: options.execution ?? native.execution, index, total_count: membership.length,
    delivery_id: preparedDeliveryId(native.request_identity, index), proofs,
    previews: Object.fromEntries(membership.map(row => [indexEntryCacheKey(row.entry), row.preview])),
    source_disclosures: Object.fromEntries(membership.map(row => [indexEntryCacheKey(row.entry),
      qualifySourceDisclosure(row.source_disclosure, row.proofs.length > 0 ? "conditional_support" : "source_only",
        options.disclose_time ?? false)])),
    slot_qualifiers: slotQualifiersFor(index, proofs).map(row => ({ ...row,
      payload_support: membership[row.index]!.payload_support,
      selection_basis: membership[row.index]!.selection_basis ?? "new_input" })),
    discovery: { ...native.discovery, truncated: options.truncated ?? native.discovery.truncated,
      open_residuals: options.open_residuals ?? native.discovery.open_residuals,
      access: { ...context.pool.access, source_candidates: sourceCandidates, trace: { kind: "library_selection",
        omitted_source_count: context.pool.access.source_candidates.length - sourceCandidates.length,
        omitted_interpretation_count: 0 } } },
    coverage: { ...native.coverage, payload: options.payload ?? native.coverage.payload },
    work: reservedWork(request) });
  if (material.kind !== "recall") throw new Error("assembled public membership expected");
  const encoded = encodeSourceSemanticLibraryResponse(material);
  if (encoded.operation !== "recall" || encoded.results === undefined) throw new Error("assembled public membership expected");
  return { ...encoded, results: encoded.results };
}

/** Independent single-page sizing oracle over the complete frozen membership,
 * not a delivery, selector replay, or a copied production reservation byte count. */
export function combinedMembershipEnvelope(context: NativeSubsetContext, measurement: NativeMeasurement) {
  return assembledMembershipEnvelope(context, measurement, measurement.plan.pages.flat(), {
    more_roots: false, emitted_offset: 0 });
}

function forcedMembership(context: NativeSubsetContext, membership: readonly SourceSemanticLibraryPackage[]) {
  return measureNativeSubset(context, roomyDeliveryBytes, membership, membership, selectSourceSemanticLibraryPage);
}

function membershipBytes(context: NativeSubsetContext, measurement: NativeMeasurement,
  membership: readonly SourceSemanticLibraryPackage[],
  options: Parameters<typeof assembledMembershipEnvelope>[3]): number {
  return Buffer.byteLength(JSON.stringify(assembledMembershipEnvelope(context, measurement, membership, options)));
}

function encoderDimensions(context: NativeSubsetContext, measurement: NativeMeasurement, row: SourceSemanticLibraryPackage) {
  const final = (execution: SourceSemanticExecution, extra: {
    payload?: "complete" | "truncated"; truncated?: boolean; disclose_time?: boolean;
  } = {}) => membershipBytes(context, measurement, [row], { more_roots: false, emitted_offset: 0, execution, ...extra });
  const continuing = (emitted_offset: number) => membershipBytes(context, measurement, [row], {
    more_roots: true, emitted_offset, execution: NATIVE });
  return {
    final: [final(NATIVE), final(NATIVE, { payload: "truncated", truncated: true }), final(ADMITTED),
      final(NATIVE, { disclose_time: true })],
    continuing: [continuing(0), continuing(1)]
  };
}

function discriminatingByteCap(fits: readonly number[], exceeds: readonly number[]): number {
  const cap = Math.max(...fits);
  if (!Number.isSafeInteger(cap) || exceeds.some(bytes => bytes <= cap)) {
    throw new Error(`no independent discriminating cap: fits ${fits.join(",")} exceeds ${exceeds.join(",")}`);
  }
  return cap;
}

/**
 * Lower diagnostic output cap restoring the one-final-proof, two-page regime.
 * Boundaries come from explicitly assembled membership, never selector reservation quotes.
 * Independently measure every 1-proof reserved final, take the tightest consecutive
 * encoder boundary, and require the cheaper proof to fit only as a final envelope.
 */
export function twoPageFinalProofByteCap(context: NativeSubsetContext): number {
  const proofs = context.fixture.pool, raws = proofs.map(rawSourceTwin);
  const singles = proofs.map((row, index) => {
    const measured = forcedMembership(context, [row]);
    return { row, index, measured, final: membershipBytes(context, measured, [row], {
      more_roots: false, emitted_offset: 0, execution: NATIVE }) };
  });
  const ranked = [...singles].sort((left, right) => left.final - right.final);
  if (ranked.length < 2) throw new Error("two 1-proof finals expected");
  let tightest = 0;
  for (let index = 1; index < ranked.length - 1; index++) {
    if (ranked[index + 1]!.final - ranked[index]!.final < ranked[tightest + 1]!.final - ranked[tightest]!.final) {
      tightest = index;
    }
  }
  const smaller = ranked[tightest]!, larger = ranked[tightest + 1]!;
  const smallerDims = encoderDimensions(context, smaller.measured, smaller.row);
  const largerDims = encoderDimensions(context, larger.measured, larger.row);
  const prefixRows = raws.filter((_, index) => index !== smaller.index), pairRows = [smaller.row, larger.row];
  const prefix = forcedMembership(context, prefixRows), pair = forcedMembership(context, pairRows);
  const combined = forcedMembership(context, proofs);
  const finalEnvelope = { more_roots: false, emitted_offset: 0, execution: NATIVE };
  const cap = discriminatingByteCap(
    [smaller.final, membershipBytes(context, prefix, prefixRows, { ...finalEnvelope, more_roots: true }),
      ...smallerDims.final.filter(bytes => bytes <= smaller.final)],
    [larger.final, ...smallerDims.continuing, membershipBytes(context, pair, pairRows, finalEnvelope),
      membershipBytes(context, combined, proofs, finalEnvelope), ...largerDims.final, ...largerDims.continuing]);
  if (cap >= 238405 || Math.max(...smallerDims.final) >= Math.min(larger.final, ...largerDims.final)
    || smallerDims.continuing.some(bytes => bytes <= cap)) {
    throw new Error("full encoder dimensions invert the proof-unfit two-page trigger");
  }
  return cap;
}
