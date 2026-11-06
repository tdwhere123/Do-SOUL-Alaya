import type { SourceIndexTarget, SourceIndexLexicalRank, SourceIndexRootNomination,
  SourceIndexQueryAdmission, SourceIndexAcquisitionResult, SourceIndexNominationAccounting } from "@do-soul/alaya-protocol";
import type { StatementAssociationAvailability } from "./statement-association.js";
import type { SourceTemplateRestorationObservation } from "./source-template-restoration.js";
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
}> | Readonly<{ kind: "source_template_restoration";
  observation: SourceTemplateRestorationObservation;
  index_binding: import("@do-soul/alaya-protocol").SourceIndexVectorBinding | null;
}>;
/** Kind is available without constructing a payload, including count-only inspection diagnostics. */
export type SourceIndexAcquisitionObserver = (capture: () => SourceIndexAcquisitionFact,
  kind: SourceIndexAcquisitionFact["kind"]) => void;

