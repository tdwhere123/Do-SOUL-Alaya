import type {
  ProjectMappingAnchor,
  StorageTier
} from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import type { RecallTimeFilter } from "../runtime/recall-service-helpers.js";
import type {
  RecallDegradationReason,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "../runtime/recall-service-types.js";
import type { TemporalWindowCandidateBudget } from
  "./temporal/temporal-window-candidates.js";
import type { RecallQueryEntityExtractionCapture } from
  "../field/query-entity-attribution-producer.js";
import type { RecallRetrievalFieldBundle } from
  "../field/retrieval/retrieval-field-bundle.js";

export interface RunCoarseFilterContext {
  readonly dependencies: RecallServiceDependencies;
  readonly warn: RecallServiceWarnPort;
  readonly degradationReasons?: Set<RecallDegradationReason>;
}

export interface RunCoarseFilterOptions {
  readonly tier?: StorageTier;
  readonly projectMappings?: readonly Readonly<ProjectMappingAnchor>[];
  readonly sourceChannel?: string;
  readonly scoreMultiplier?: number;
  readonly timeFilter?: RecallTimeFilter;
  readonly queryProbes?: Readonly<RecallQueryProbes>;
  readonly winnerMemoryIds?: ReadonlySet<string>;
  readonly deliveryMaxEntries?: number;
  readonly temporalCandidateBudget?: TemporalWindowCandidateBudget;
  readonly referenceTime?: string;
  readonly pathProjectionAsOf?: string;
  readonly queryEntityExtraction?: Readonly<RecallQueryEntityExtractionCapture>;
  readonly retrievalFieldBundle?: Readonly<RecallRetrievalFieldBundle>;
}
