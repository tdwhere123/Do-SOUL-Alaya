import type { RecallScoreFactors } from "@do-soul/alaya-protocol";
import type {
  CoarseRecallCandidate,
  RecallFusionBreakdown
} from "../runtime/recall-service-types.js";

export type DeliverySelectionCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
  readonly fusion: RecallFusionBreakdown;
}>;
