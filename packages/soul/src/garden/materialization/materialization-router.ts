export { MaterializationRouter } from "./materialization-router/router.js";
export {
  DISTILLED_FACT_MAX_CHARS,
  buildDistilledFact,
  buildEvidenceInput
} from "./materialization-router/inputs.js";
export { SIGNAL_REF_SEED_SPECS } from "./materialization-router/signal-ref-seeds.js";
export type {
  GraphEdgeCreationPort,
  MaterializationRouterDeps,
  PathCandidateMintOutcome,
  PathRelationProposalPayload,
  SourceObservationPublicationPort,
  TemporalRelationAssertionPort,
  RouteTarget,
  SignalRefSeedSpec
} from "./materialization-router/contracts.js";
