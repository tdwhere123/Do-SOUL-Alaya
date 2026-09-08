import type {
  MemoryEntry,
  RecallPolicy
} from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import type { RecallEvidenceProjectionMatchReceipt } from
  "../runtime/recall-service-results.js";
import type {
  RecallDegradationReason,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "../runtime/recall-service-types.js";
import type { RecallRetrievalFieldBundle } from
  "../field/retrieval/retrieval-field-bundle.js";
import type { AddCoarseCandidate } from "./coarse-filter-admission.js";

export interface RunCoarseFilterContext {
  readonly dependencies: RecallServiceDependencies;
  readonly warn: RecallServiceWarnPort;
  readonly degradationReasons?: Set<RecallDegradationReason>;
}

export interface SemanticSupplementParams {
  readonly context: RunCoarseFilterContext;
  readonly workspaceId: string;
  readonly config: Readonly<RecallPolicy>["coarse_filter"];
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly tier: MemoryEntry["storage_tier"];
  readonly tierScopedSearchEligible: boolean;
  readonly byId: Map<string, Readonly<MemoryEntry>> | ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly addCandidate: AddCoarseCandidate;
  readonly ftsRanks: Map<string, number>;
  readonly trigramFtsRanks: Map<string, number>;
  readonly evidenceFtsRanks: Map<string, number>;
  readonly evidenceFtsRanksPerRef: Map<string, number>;
  readonly evidenceProjectionMatchesByRef: Map<
    string,
    RecallEvidenceProjectionMatchReceipt[]
  >;
  readonly retrievalFieldBundle: Readonly<RecallRetrievalFieldBundle>;
}
