export {
  BINDING_RELATION_STATES,
  bindingInformationLeq,
  compareBindingRelation,
  createBindingRelationWitness,
  joinBindingRelation,
  meetBindingRelation,
  refineBindingRelation,
  type BindingRelationInput,
  type BindingRelationPayload,
  type BindingRelationState,
  type BindingRelationWitness
} from "./domains/binding.js";
export {
  BINDING_RELATION_EVIDENCE_OPERATOR_ID,
  type BindingConcreteRelation,
  type BindingRelationEvidenceReceiptV1,
  type BindingRelationEvidenceVerifierV1,
  type BindingSourceObservationReceiptV1
} from "./domains/binding-evidence.js";
export {
  compareCorrelation,
  CORRELATION_STATES,
  correlationInformationLeq,
  createCorrelationWitness,
  joinCorrelation,
  meetCorrelation,
  refineCorrelation,
  type CorrelationInput,
  type CorrelationPayload,
  type CorrelationState,
  type CorrelationWitness
} from "./domains/correlation.js";
export {
  compareMembershipFrontier,
  createMembershipFrontierWitness,
  frontierInformationLeq,
  joinMembershipFrontier,
  meetMembershipFrontier,
  refineMembershipFrontier,
  type MembershipFrontierInput,
  type MembershipFrontierPayload,
  type MembershipFrontierWitness
} from "./domains/frontier.js";
export {
  createMustMayWitness,
  compareMustMay,
  joinMustMay,
  meetMustMay,
  mustMayInformationLeq,
  refineMustMay,
  type MustMayInput,
  type MustMayPayload,
  type MustMayWitness
} from "./domains/must-may.js";
export {
  compareNumericInterval,
  createNumericIntervalWitness,
  joinNumericInterval,
  meetNumericInterval,
  numericInformationLeq,
  refineNumericInterval,
  type NumericIntervalInput,
  type NumericIntervalPayload,
  type NumericIntervalWitness
} from "./domains/numeric.js";
export {
  compareFourValued,
  createFourValuedWitness,
  FOUR_VALUED_POLARITIES,
  fourValuedInformationLeq,
  joinFourValued,
  meetFourValued,
  refineFourValued,
  type FourValuedInput,
  type FourValuedPayload,
  type FourValuedPolarity,
  type FourValuedWitness
} from "./domains/proposition.js";
export {
  bitemporalInformationLeq,
  compareBitemporal,
  createBitemporalWitness,
  joinBitemporal,
  meetBitemporal,
  refineBitemporal,
  type BitemporalInput,
  type BitemporalPayload,
  type BitemporalWitness,
  type TransactionTimeForm,
  type ValidTimeForm
} from "./domains/temporal.js";
export {
  witnessFromShadowEnvelope,
  type EnvelopeWitnessFrame
} from "./envelope-adapter.js";
export {
  assertCompletenessApplies,
  parseCompleteness
} from "./shared/completeness.js";
export {
  completenessOwner,
  conflictEpistemic,
  exactEpistemic,
  freezeEpistemic,
  isKnownZeroEpistemic,
  isUnknownEpistemic,
  parseEpistemic,
} from "./shared/epistemic.js";
export {
  assembleWitness,
  consumerView,
  digestWitness,
  freezeWitness,
  serializeWitness
} from "./shared/frame.js";
export {
  assertIdentityPreserved,
  freezeIdentity,
  identitiesEqual,
  parseIdentityPins
} from "./shared/identity.js";
export {
  extendProvenance,
  freezeProvenance,
  parseProvenance,
  unionProvenance
} from "./shared/provenance.js";
export {
  WITNESS_DOMAIN_KINDS,
  type TypedWitness,
  type WitnessCompleteness,
  type WitnessCreateInput,
  type WitnessDomainKind,
  type WitnessEpistemic,
  type WitnessEpistemicKind,
  type WitnessIdentityPins,
  type WitnessInformationOrder,
  type WitnessProvenanceEntry
} from "./shared/types.js";
