import type { FtsLaneId, FtsLaneRankRow } from "@do-soul/alaya-protocol";
import type { EvidenceSearchProjectionIdentity } from "../../evidence-recall-types.js";

export type EvidenceFtsLane = Exclude<FtsLaneId, "exact">;

export interface ProjectionRankRow extends FtsLaneRankRow {
  readonly projection_id: number;
  readonly projection_kind: EvidenceSearchProjectionIdentity["projection_kind"];
  readonly projection_content: string;
  readonly owner_content: string;
  readonly owner_gist: string;
  readonly source_hash: string;
}

export type EvidenceLaneRows = Readonly<{
  readonly owners: readonly FtsLaneRankRow[];
  readonly projections: readonly ProjectionRankRow[];
}>;

export type EvidenceKeywordLaneBundle = Readonly<{
  readonly porter: EvidenceLaneRows;
  readonly trigram: EvidenceLaneRows;
}>;
