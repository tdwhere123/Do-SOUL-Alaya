export {
  createSupportHypergraph,
  type SupportHypergraphInputV1
} from "./graph.js";
export {
  digestSupportHypergraph,
  type SupportHypergraphBodyV1,
  type SupportHypergraphReceiptV1
} from "./receipt.js";
export {
  provedDistinctBindingCount,
  type ProvedDistinctBindingsV1
} from "./distinctness.js";
export { CORRELATION_CONFLICT_REASON } from "./records.js";
export {
  SUPPORT_EDGE_KINDS,
  SUPPORT_HYPERGRAPH_OPERATOR_ID,
  SUPPORT_NODE_KINDS,
  type SupportAliasRecordV1,
  type SupportCorrelationRecordV1,
  type SupportEdgeKind,
  type SupportEdgeV1,
  type SupportEndpointV1,
  type SupportNodeKind,
  type SupportNodeV1
} from "./types.js";
export {
  SUPPORT_RELATIONAL_RECEIPT_OPERATOR_ID,
  verifySupportRelationalReceiptV1,
  type RelationalAuthorityVerificationV1
} from "./adapters/relational-authority.js";
export {
  issuedSupportSourceBinding,
  materializeSupportFromReceipts,
  type SupportMaterializationV1
} from "./adapters/materialize.js";
export type {
  SupportCandidateReceiptV1,
  SupportMaterializationOutcomeV1,
  SupportMaterializationInputV1,
  SupportObservabilityGapV1,
  SupportPropositionObservationV1,
  SupportRelationalReceiptV1,
  SupportRelationalSourceObservationReceiptV1,
  SupportRelationalSourceVerifierV1,
  SupportRelationalSubjectV1
} from "./adapters/types.js";
