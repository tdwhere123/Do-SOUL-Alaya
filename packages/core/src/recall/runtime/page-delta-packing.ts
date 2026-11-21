import {
  SourceSemanticResourceExhausted,
  SourceSemanticResourceLedger,
  canonicalIndexEntryIdentity,
  sourceDisclosureFieldByteSavings,
  type InformationIndex,
  type MemorySearchResult,
  type SourceDisclosure
} from "@do-soul/alaya-protocol";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { CoreError } from "../../shared/errors.js";
import { quoteIndexDeliveryRetention, type ProjectionProgress } from "./index-continuation.js";
import type { BoundedIndexPayload } from "./index-payload.js";
import { encodeIndexResults } from "./recall-page-encoding.js";
import { PAYLOAD_OMITTED_PREVIEW } from "./recall-result-encoding.js";
import { deliveryBudgetOf, framingReserve } from "./recall-page-fit.js";
import type { ConditionalFieldRecallRequest } from "./recall-service-runner-types.js";
import type { RequestCostLedger } from "./request-cost-ledger.js";

const PAGE_DELTA_PREFIX_LIMIT = 5;

export interface PackableMembershipCandidate {
  readonly index: InformationIndex;
  readonly payload: BoundedIndexPayload;
  readonly framing: number;
  readonly retained: FieldEngineState;
  readonly first_retention: boolean;
}

export type PageDeltaPackingResult<TCandidate extends PackableMembershipCandidate> =
  | Readonly<{ candidate: TCandidate; packed: false }>
  | Readonly<{
    candidate: TCandidate;
    packed: true;
    j: number;
    anyNextExtended: boolean;
    restoreFragments: () => void;
  }>;

function isInitialOrdinaryMembershipPage(
  input: ConditionalFieldRecallRequest,
  progress: ProjectionProgress
): boolean {
  return input.continuation == null
    && progress.offset === 0
    && input.payload_continuation === undefined
    && input.encode_page === undefined;
}

export function prepareInitialPageDeltaPacking<TCandidate extends PackableMembershipCandidate>(params: Readonly<{
  input: ConditionalFieldRecallRequest;
  projectionProgress: ProjectionProgress;
  candidate: TCandidate;
  cost: RequestCostLedger;
  remainingWorkFields: (
    state: FieldEngineState,
    total: number
  ) => Pick<FieldEngineState, "remaining_reserve" | "remaining_exploration">;
  projectAtWidth: (nextAvailableWork: number, nextMemoryBytes: number, width: number) => TCandidate;
}>): PageDeltaPackingResult<TCandidate> {
  const { input, projectionProgress, cost, remainingWorkFields, projectAtWidth } = params;
  let candidate = params.candidate;
  if (!isInitialOrdinaryMembershipPage(input, projectionProgress)) return { candidate, packed: false };
  if (candidate.index.entries.length === 0 || candidate.index.completeness.logical_index === "invalidated") {
    return { candidate, packed: false };
  }

  const stampedIndex = candidate.payload.applyDeliveredSpans(candidate.index);
  const prefixLimit = Math.min(PAGE_DELTA_PREFIX_LIMIT, stampedIndex.entries.length);
  const available = candidate.retained.remaining_exploration + candidate.retained.remaining_reserve;
  const stage1WorkBudget = Math.max(0, available - framingReserve(prefixLimit + 1));
  if (stage1WorkBudget < prefixLimit) return { candidate, packed: false };

  const maxTotalTokens = deliveryBudgetOf(input).max_total_tokens;
  const ledger = new SourceSemanticResourceLedger({
    work_units: stage1WorkBudget,
    memory_bytes: candidate.payload.remainingMemoryBytes
  });

  const partitioned = partitionVirtualLiteralPages(stampedIndex, prefixLimit, maxTotalTokens, candidate.payload, ledger, cost);
  const postStage1Work = Math.max(0, available - ledger.spentWork);
  const withStage1Spend = (target: TCandidate): TCandidate => ({
    ...target,
    retained: { ...target.retained, ...remainingWorkFields(target.retained, postStage1Work) }
  });
  if (partitioned === null || partitioned.fragments.length === 0
    || partitioned.firstVirtualWidth === 0 || partitioned.exceedsPrefixLimit) {
    return { candidate: withStage1Spend(candidate), packed: false };
  }

  const widened = selectWidenedDeltaPrefix(partitioned.fragments, maxTotalTokens);
  if (widened.j < partitioned.firstVirtualWidth || widened.j === 0) {
    return { candidate: withStage1Spend(candidate), packed: false };
  }

  const originalEntries = candidate.index.entries;
  if (widened.j < originalEntries.length) {
    candidate = projectAtWidth(postStage1Work + candidate.framing, candidate.payload.remainingMemoryBytes, widened.j);
    if (candidate.index.entries.length !== widened.j
      || candidate.index.entries.some((entry, idx) =>
        canonicalIndexEntryIdentity(entry) !== canonicalIndexEntryIdentity(originalEntries[idx]!))) {
      return { candidate, packed: false };
    }
  } else {
    candidate = withStage1Spend(candidate);
  }

  const restoreFragments = candidate.payload.snapshotDeliveredFragments(candidate.index.entries);
  for (let i = 0; i < widened.j; i++) {
    const frag = partitioned.fragments[i]!;
    if (frag.payload_available !== true) {
      candidate.payload.omitDeliveredFragment(candidate.index.entries[i]!);
      continue;
    }
    candidate.payload.lockDeliveredFragment(
      candidate.index.entries[i]!,
      frag.content_preview,
      frag.target.kind === "source_evidence" ? frag.target.span : undefined
    );
  }

  const nextOutcome = runResidualNextCompletions({
    candidate,
    j: widened.j,
    initialResidualBytes: widened.residualBytes,
    deliveredEntries: projectionProgress.delivered_entries,
    cost,
    remainingWorkFields
  });
  if (widened.j === partitioned.firstVirtualWidth && !nextOutcome.anyNextExtended && widened.totalSavings === 0) {
    restoreFragments();
    return { candidate: nextOutcome.candidate, packed: false };
  }
  return {
    candidate: nextOutcome.candidate,
    packed: true,
    j: widened.j,
    anyNextExtended: nextOutcome.anyNextExtended,
    restoreFragments
  };
}

function partitionVirtualLiteralPages(
  stampedIndex: InformationIndex,
  prefixLimit: number,
  maxTotalTokens: number,
  payload: BoundedIndexPayload,
  ledger: SourceSemanticResourceLedger,
  cost: RequestCostLedger
): Readonly<{ fragments: readonly MemorySearchResult[]; firstVirtualWidth: number; exceedsPrefixLimit: boolean }> | null {
  const entries = stampedIndex.entries;
  const fragments: MemorySearchResult[] = [];
  let firstVirtualWidth = 0;
  let exceedsPrefixLimit = false;
  let cursor = 0;
  let exhausted = false;
  try {
    cost.time("index", () => {
      while (cursor < prefixLimit) {
        const slice = entries.slice(cursor, prefixLimit);
        let w = slice.length;
        let fittedSlice: readonly MemorySearchResult[] = [];
        for (;;) {
          const virtualIndex: InformationIndex = {
            ...stampedIndex,
            entries: slice.slice(0, w),
            representation: {
              schema_version: stampedIndex.representation.schema_version,
              policy: stampedIndex.representation.policy,
              page_budget: w,
              identity_tie_break: stampedIndex.representation.identity_tie_break
            }
          };
          const enc = encodeIndexResults(
            virtualIndex,
            payload.previews,
            maxTotalTokens,
            payload.sourceMetadata,
            () => ledger.charge(1, 0, "virtual page fragment partition"),
            undefined,
            { dependency_byte_limit: 0 }
          );
          if (enc.length === w || w <= 1) {
            fittedSlice = enc;
            break;
          }
          const nextW = Math.min(w - 1, enc.length, slice.length - 1);
          if (nextW < 1) {
            fittedSlice = enc;
            break;
          }
          w = nextW;
        }
        if (fittedSlice.length === 0) break;
        if (cursor === 0) firstVirtualWidth = fittedSlice.length;
        fragments.push(...fittedSlice);
        cursor += fittedSlice.length;
      }
      if (firstVirtualWidth === PAGE_DELTA_PREFIX_LIMIT && entries.length > PAGE_DELTA_PREFIX_LIMIT) {
        const probeWidth = PAGE_DELTA_PREFIX_LIMIT + 1;
        const probeIndex: InformationIndex = {
          ...stampedIndex,
          entries: entries.slice(0, probeWidth),
          representation: {
            schema_version: stampedIndex.representation.schema_version,
            policy: stampedIndex.representation.policy,
            page_budget: probeWidth,
            identity_tie_break: stampedIndex.representation.identity_tie_break
          }
        };
        const probe = encodeIndexResults(
          probeIndex,
          payload.previews,
          maxTotalTokens,
          payload.sourceMetadata,
          () => ledger.charge(1, 0, "virtual page prefix limit probe"),
          undefined,
          { dependency_byte_limit: 0 }
        );
        exceedsPrefixLimit = probe.length === probeWidth;
      }
    });
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    exhausted = true;
  } finally {
    cost.add("index", { budget_work: ledger.spentWork, charged_retained_bytes: ledger.spentBytes });
  }
  return exhausted ? null : { fragments, firstVirtualWidth, exceedsPrefixLimit };
}

function omittedFragmentLiteralBytes(frag: MemorySearchResult): number {
  const disclosureBytes = frag.source_disclosure === undefined
    ? 0
    : Buffer.byteLength(JSON.stringify({ source_disclosure: frag.source_disclosure }));
  const pointerWarningBytes = frag.evidence_pointers.length === 0 && (frag.staged_warnings?.length ?? 0) === 0
    ? 0
    : Buffer.byteLength(JSON.stringify({
      evidencePointers: frag.evidence_pointers,
      stagedWarnings: frag.staged_warnings
    }));
  return Math.max(1, Buffer.byteLength(PAYLOAD_OMITTED_PREVIEW) + disclosureBytes + pointerWarningBytes);
}

function selectWidenedDeltaPrefix(
  fragments: readonly MemorySearchResult[],
  maxTotalTokens: number
): Readonly<{ j: number; residualBytes: number; totalSavings: number }> {
  let anchorDisclosure: SourceDisclosure | undefined;
  let cumulativeBytes = 0;
  let j = 0;
  let profiledUsedBytes = 0;
  let totalSavings = 0;
  for (let i = 0; i < fragments.length; i++) {
    const frag = fragments[i]!;
    let savings = 0;
    if (frag.source_disclosure !== undefined) {
      if (anchorDisclosure === undefined) anchorDisclosure = frag.source_disclosure;
      else savings = sourceDisclosureFieldByteSavings(frag.source_disclosure, anchorDisclosure);
    }
    const literalEstimate = frag.payload_available === true
      ? frag.budget_state.token_estimate
      : Math.max(frag.budget_state.token_estimate, omittedFragmentLiteralBytes(frag));
    const nextUsed = cumulativeBytes + literalEstimate - savings;
    if (nextUsed > maxTotalTokens) break;
    cumulativeBytes = nextUsed;
    j = i + 1;
    profiledUsedBytes = cumulativeBytes;
    totalSavings += savings;
  }
  return { j, residualBytes: Math.max(0, maxTotalTokens - profiledUsedBytes), totalSavings };
}

function runResidualNextCompletions<TCandidate extends PackableMembershipCandidate>(params: Readonly<{
  candidate: TCandidate;
  j: number;
  initialResidualBytes: number;
  deliveredEntries: ProjectionProgress["delivered_entries"];
  cost: RequestCostLedger;
  remainingWorkFields: (
    state: FieldEngineState,
    total: number
  ) => Pick<FieldEngineState, "remaining_reserve" | "remaining_exploration">;
}>): Readonly<{ candidate: TCandidate; anyNextExtended: boolean }> {
  const { candidate, j, deliveredEntries, cost, remainingWorkFields } = params;
  let residualBytes = params.initialResidualBytes;
  let anyNextExtended = false;
  if (residualBytes <= 0) return { candidate, anyNextExtended };

  let currentWork = candidate.retained.remaining_exploration + candidate.retained.remaining_reserve + candidate.framing;
  const retentionBytes = quoteIndexDeliveryRetention(deliveredEntries, candidate.index.entries, candidate.first_retention);
  const framingHold = framingReserve(j);

  for (let i = 0; i < j && residualBytes > 0; i++) {
    let failed = false;
    let spentWork = 0;
    try {
      const ext = cost.time("payload", () => candidate.payload.extendNextMessageBoundary({
        entry: candidate.index.entries[i]!,
        residualBytes,
        availableWork: currentWork,
        framingReserve: framingHold,
        retentionBytes
      }));
      spentWork = ext.spentWork;
      if (ext.extendedBytes > 0) {
        residualBytes -= ext.extendedBytes;
        anyNextExtended = true;
      }
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted) && !(error instanceof CoreError)) throw error;
      failed = true;
    } finally {
      const work = candidate.payload.takeWork();
      cost.add("payload", work);
      const deducted = failed ? Math.max(spentWork, work.native_visits) : spentWork;
      currentWork = Math.max(0, currentWork - deducted);
    }
    if (failed) break;
  }

  const nextFraming = Math.min(candidate.framing, currentWork);
  const remainingPostStage2 = currentWork - nextFraming;
  return {
    candidate: {
      ...candidate,
      framing: nextFraming,
      retained: { ...candidate.retained, ...remainingWorkFields(candidate.retained, remainingPostStage2) }
    },
    anyNextExtended
  };
}
