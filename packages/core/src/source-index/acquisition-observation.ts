import type { SourceIndexTarget, SourceIndexLexicalRank, SourceIndexLexicalCandidate, SourceIndexRootNomination,
  SourceIndexQueryAdmission, SourceIndexAcquisitionResult, SourceIndexNominationAccounting } from "@do-soul/alaya-protocol";
import { taskObservationAllowsSource, taskObservationCandidates } from "./task-observation-preference.js";
import type { StatementAssociationAvailability } from "./statement-association.js";
import type { SourceTemplateRestorationObservation } from "./source-template-restoration.js";
import type { TaskObservationInspection } from "./task-observation-preference.js";
type QueryResourceRefusal = SourceIndexAcquisitionResult["resource_refusals"][number];

export type NativeAdmissionFact =
  | Pick<Extract<SourceIndexQueryAdmission, { status: "stale" | "partial" | "unbound" }>, "status" | "reason">
  | Pick<Extract<SourceIndexQueryAdmission, { status: "resource_limited" }>, "status" | "reason" | "phase">;

/** Core-owned acquisition facts. Not a public receipt, protocol schema or daemon type.
 * Rank on vector_ranked exists only after the whole finalized ranked set is retained.
 */
export type SourceIndexAcquisitionFact = Readonly<{
  kind: "lexical_candidate"; target: SourceIndexTarget["target"];
  lane: SourceIndexLexicalRank["lane"]; rank: number; lane_rank: number; bm25: number;
  domain?: SourceIndexLexicalRank["domain"];
}> | Readonly<{
  kind: "source_task_inventory"; state: "active" | "inactive" | "unavailable"; reason?: string;
  coverage: "complete" | "partial"; original: readonly SourceIndexTarget[];
  incumbent?: readonly SourceIndexTarget[]; eligible?: readonly SourceIndexTarget[];
  native: Pick<SourceIndexAcquisitionResult, "lexical" | "vector" | "resource_refusals" | "accounting">;
}> | Readonly<{
  kind: "vector_inspected"; target: SourceIndexTarget["target"];
  window: NonNullable<SourceIndexRootNomination["vector"]>["window"]; cosine: number;
}> | Readonly<{
  kind: "vector_ranked"; target: SourceIndexTarget["target"];
  window: NonNullable<SourceIndexRootNomination["vector"]>["window"]; cosine: number; rank: number;
}> | Readonly<{
  kind: "nomination_attempt"; channel: "lexical" | "vector"; target: SourceIndexTarget["target"];
  disposition: "admitted" | "duplicate" | "nomination_limit" | "scope_denied"
    | "stale" | "native_unknown" | "resource_refused" | "rejected";
  /** Native admission status/reason/phase. Absent when the attempt never returned one. */
  admission?: NativeAdmissionFact;
  /** Previous retained gold-root target when this attempt merged as a duplicate. Absent otherwise. */
  merge_target?: SourceIndexTarget["target"];
  /** Producer-owned refusal recorded for this attempt. Absent when none was recorded.
   * Reuses result resource_refusals semantics; not a native admission. */
  resource_refusal?: QueryResourceRefusal;
}> | Readonly<{
  kind: "acquisition_complete"; completion: SourceIndexAcquisitionResult["completion"];
  accounting: SourceIndexNominationAccounting;
  lexical_completion: SourceIndexAcquisitionResult["lexical"]["completion"];
  vector_completion: SourceIndexAcquisitionResult["vector"]["completion"];
  statement_association: StatementAssociationAvailability;
}> | Readonly<{ kind: "source_task_observation"; observation: TaskObservationInspection; }> | Readonly<{ kind: "source_template_restoration";
  observation: SourceTemplateRestorationObservation;
  index_binding: import("@do-soul/alaya-protocol").SourceIndexVectorBinding | null;
}>;
/** Kind is available without constructing a payload, including count-only inspection diagnostics. */
export type SourceIndexAcquisitionObserver = (capture: () => SourceIndexAcquisitionFact,
  kind: SourceIndexAcquisitionFact["kind"]) => void;

/** Route ranks are local to the capture domain, not a merged ranking. */
export function observeLexicalCandidates(candidates: readonly SourceIndexLexicalCandidate[],
  observe: (capture: () => SourceIndexAcquisitionFact) => void, domain?: SourceIndexLexicalRank["domain"]): void {
  for (const candidate of candidates) observe(() => ({ kind: "lexical_candidate", target: candidate.source.target,
    lane: candidate.lexical.lane, rank: candidate.lexical.rank, lane_rank: candidate.lexical.lane_rank,
    bm25: candidate.lexical.bm25, ...(domain === undefined ? {} : { domain }) }));
}

/** Bounded diagnostic snapshot of the exact inputs to the task preference, not a second nomination. */
export function sourceTaskInventory<N extends SourceIndexRootNomination>(input: Readonly<{
  state: "active" | "inactive" | "unavailable"; reason?: string; restrictedComplete: boolean; sourceId?: string;
  original: readonly (readonly [string, N])[]; nominations: ReadonlyMap<string, N>; result: SourceIndexAcquisitionResult;
}>): SourceIndexAcquisitionFact {
  const { lexical, vector, resource_refusals, accounting } = input.result;
  const partial = !input.restrictedComplete || lexical.completion !== "complete" || vector.completion !== "complete"
    || resource_refusals.length > 0 || accounting.native_unknown > 0 || accounting.resource_refused > 0;
  return { kind: "source_task_inventory", state: input.state, ...(input.reason === undefined ? {} : { reason: input.reason }),
    coverage: partial ? "partial" : "complete", original: input.original.map(([, row]) => row.source),
    ...(input.state !== "active" ? {} : { incumbent: [...input.nominations.values()].map(row => row.source),
      eligible: [...taskObservationCandidates(input.original, input.nominations).values()].map(row => row.source)
        .filter(source => taskObservationAllowsSource(source, input.sourceId)) }),
    native: { lexical, vector, resource_refusals, accounting } };
}

