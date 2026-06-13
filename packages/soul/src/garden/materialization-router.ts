export { MaterializationRouter } from "./materialization-router/router.js";
export { DISTILLED_FACT_MAX_CHARS, buildDistilledFact } from "./materialization-router/inputs.js";
export { SIGNAL_REF_SEED_SPECS } from "./materialization-router/signal-ref-seeds.js";
export type {
  ConflictDetectionPort,
  EnrichPendingPort,
  GraphEdgeCreationPort,
  MaterializationCreatedObject,
  MaterializationResult,
  MaterializationRouterDeps,
  MaterializationTarget,
  MemoryMaterializationCreatedObject,
  PathCandidateMintOutcome,
  PathCandidateSinkPort,
  PathRelationProposalPayload,
  PathRelationProposalPort,
  ReconciliationDecisionView,
  ReconciliationPort,
  RouteTarget,
  SignalRefSeedSpec
} from "./materialization-router/contracts.js";
