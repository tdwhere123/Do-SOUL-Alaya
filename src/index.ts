export { createAlayaRuntime } from "./runtime/runtime.js";
export type {
  AlayaRuntimeOptions,
  AlayaRuntimePort,
  AuditedContextPackInput,
  AuditedGovernanceActionInput,
  AuditedGovernanceBypassInput,
  AuditedManifestationResolveInput,
  AuditedMemorySessionEventInput,
  AuditedMemoryVisibilityInput,
  AuditedOntologyWriteInput,
  AuditedPathRelationWriteInput,
  AuditedPromotionDecisionInput,
  AuditedProposalRecordInput,
  AuditedProviderSelectionInput,
  AuditedRecallContextInput,
  AuditedRuntimeDecisionInput,
  AuditedRuntimeDecisionReceipt,
  AuditedTrustSummaryInput,
  MemoryVisibilityDecision
} from "./runtime/types.js";
export {
  AlayaValidationError,
  AlayaRuntimeError,
  AuditedMutationExecutionError,
  AuditedMutationNotificationError,
  InvalidRuntimeDecisionKindError,
  MissingAuditInputError
} from "./runtime/audit-types.js";
export type {
  AlayaAuditEvidence,
  AlayaAuditSource,
  AlayaAuditTarget,
  AuditedMutationInput,
  AuditedMutationRecord,
} from "./runtime/audit-types.js";
export type {
  DoctorAppliedMigration,
  DoctorComponent,
  DoctorComponentStatus,
  DoctorReport,
  DoctorStorageReport
} from "./doctor/report.js";
export type { JsonObject, JsonPrimitive, JsonValue } from "./runtime/json.js";
export type {
  ClaimForm,
  EvidenceCapsule,
  MemoryEntry,
  OntologyRecord,
  SynthesisCapsule
} from "./ontology/index.js";
export type {
  ActivationCandidate,
  ManifestationBudgetConfig,
  ManifestationDecision,
  PathAnchorRef,
  PathRelation,
  TopologyProjection
} from "./structure/index.js";
export type {
  GovernanceActionRequest,
  GovernanceBypassSignal,
  GovernancePolicyDecision,
  PromotionCandidate,
  PromotionDecision,
  PromotionGate
} from "./governance/index.js";
export type {
  ApplyEmbeddingSupplementInput,
  AssembleContextPackInput,
  ContextPack,
  ContextPackBudget,
  ContextPackDeliveryMetadata,
  ContextPackIncluded,
  EmbeddingProviderState,
  EmbeddingSupplementCandidate,
  EmbeddingSupplementConfig,
  MergePathRecallContributionsInput,
  RankLexicalRecallCandidatesInput,
  RecallCandidate,
  RecallDegradation,
  RecallExclusion,
  RecallGovernanceState,
  RecallMemoryRecord,
  RecallMergeResult,
  RecallQuery,
  RecallRoute,
  RecallRouteContribution,
  RecallSourcePlane
} from "./recall/index.js";
export {
  applyEmbeddingSupplement,
  assembleContextPack,
  mergePathRecallContributions,
  rankLexicalRecallCandidates
} from "./recall/index.js";
export type {
  BackgroundProposalJobInput,
  BackgroundProposalJobStatus,
  BackgroundProposalJobSummary,
  ProposalGovernanceOutcome,
  ProposalLifecycleState,
  ProposalRecord,
  ProposalScope,
  ProposalSource,
  ProposalSourceKind,
  ProposalValidationResult,
  ProviderCapability,
  ProviderHealthState,
  ProviderHealthStatus,
  ProviderRegistryEntry,
  ProviderSelectionRequest,
  ProviderSelectionResult,
  ProviderSelectionStatus
} from "./provider/index.js";
export {
  createRejectedProposalRecord,
  selectProviderForCapability,
  summarizeBackgroundProposalJob,
  validateProposalRecord
} from "./provider/index.js";
export type {
  ContextDeliveryOutcome,
  ContextDeliveryRecord,
  MemorySessionEvent,
  MemorySessionEventType,
  SessionTerminalStatus,
  SessionTrustState,
  TerminalEventSummary,
  TrustSummary,
  TrustSummarySourceCounts,
  UsageProofRecord,
  UsageProofStrength
} from "./session/index.js";
export {
  deriveTrustSummary,
  recordSessionEvent,
  validateContextDeliveryRecord,
  validateMemorySessionEvent,
  validateUsageProofRecord
} from "./session/index.js";
export type {
  BuildProfileChangePreviewInput,
  BuildProjectOverrideChangeRecordInput,
  EffectiveProfileConfig,
  ProfileChangePreview,
  ProfileChangeRecord,
  ProfileConfigDiffEntry,
  ProfileConfigMap,
  ProfileConfigScalar,
  ProfileConfigSource,
  ProfileConfigSourceRecord,
  ProfileConfigValue,
  ProfileScope,
  ResolveProfileConfigInput
} from "./profile/index.js";
export {
  buildProfileChangePreview,
  buildProjectOverrideChangeRecord,
  profileConfigSources,
  profileScopes,
  resolveProfileConfig
} from "./profile/index.js";
export type {
  BuildProfileAttachResultInput,
  BuildProfileAttachSessionEventMetadataInput,
  BuildProfileTargetWritePreviewInput,
  ProfileAttachConflictReport,
  ProfileAttachDecision,
  ProfileAttachDecisionInput,
  ProfileAttachOverallStatus,
  ProfileAttachRecordStatus,
  ProfileAttachResult,
  ProfileAttachResultRecord,
  ProfileAttachTarget,
  ProfileAttachTargetSnippet,
  ProfileAttachWriteResult,
  ProfileTargetWritePreview
} from "./profile/attach.js";
export {
  buildProfileAttachResult,
  buildProfileAttachSessionEventMetadata,
  buildProfileTargetWritePreview,
  getProfileAttachTargetSnippet,
  profileAttachDecisions,
  profileAttachOverallStatuses,
  profileAttachRecordStatuses,
  profileAttachTargets,
  profileAttachTargetSnippets,
  profileAttachWriteResults
} from "./profile/attach.js";
export type {
  CreateEnvSecretRefInput,
  CreateLocalFileSecretRefInput,
  ResolveSecretRefOptions,
  SecretRef,
  SecretRefSourceType,
  SecretResolutionState,
  SecretResolutionStatus
} from "./secrets/index.js";
export {
  createEnvSecretRef,
  createLocalFileSecretRef,
  resolveSecretRef,
  secretRefSourceTypes,
  secretResolutionStates
} from "./secrets/index.js";
export type {
  DeriveEmbeddingStatusInput,
  DeriveProviderStatusInput,
  EmbeddingEffectiveMode,
  EmbeddingStatusReport,
  ProviderStatusAuditContext,
  ProviderStatusReport,
  ProviderStatusState
} from "./provider/status.js";
export {
  deriveEmbeddingStatus,
  deriveProviderStatus,
  embeddingEffectiveModes,
  providerStatusStates
} from "./provider/status.js";
export type {
  AlayaIntegrationRuntimeBoundary,
  IntegrationCapability,
  IntegrationOperationDescriptor,
  IntegrationOperationId,
  IntegrationOperationInputMap,
  IntegrationOperationResultMap,
  IntegrationStrictnessMetadata,
  IntegrationStrictnessMode
} from "./integration/index.js";
export {
  findIntegrationOperationDescriptor,
  getIntegrationOperationDescriptor,
  integrationCapabilities,
  integrationOperationDescriptors,
  integrationOperationIds,
  integrationStrictnessModes,
  invokeIntegrationOperation,
  listIntegrationOperationDescriptors
} from "./integration/index.js";
export type {
  AlayaMcpSurfaceDescriptor,
  McpPromptDescriptor,
  McpResourceClassification,
  McpResourceClassificationMetadata,
  McpResourceDescriptor,
  McpToolDescriptor,
  McpToolInput,
  McpToolInvocation,
  McpToolInvocationResult,
  McpToolName,
  McpToolOperationId,
  McpToolResult,
  McpTruthPlane
} from "./mcp/index.js";
export {
  alayaMcpSurfaceDescriptor,
  findMcpResourceDescriptor,
  findMcpToolDescriptor,
  invokeMcpTool,
  listMcpPromptDescriptors,
  listMcpResourceDescriptors,
  listMcpToolDescriptors,
  mcpPromptDescriptors,
  mcpResourceDescriptors,
  mcpToolDescriptors
} from "./mcp/index.js";
export type {
  AlayaOperationContract,
  AlayaOperationName,
  AlayaOperationPayload,
  AlayaOperationPayloadMap,
  AlayaOperationTransport,
  CliFallbackFailureResponse,
  CliFallbackResponse,
  CliFallbackSuccessResponse,
  NormalizedAlayaOperationRequest,
  NormalizeCliFallbackRequestInput,
  NormalizeMcpOperationRequestInput,
  OperationParityShape
} from "./cli/fallback.js";
export {
  createCliFallbackFailureResponse,
  createCliFallbackSuccessResponse,
  InvalidCliFallbackPayloadError,
  normalizeCliFallbackRequest,
  normalizeMcpOperationRequest,
  toOperationParityShape,
  UnsupportedCliFallbackOperationError
} from "./cli/fallback.js";
export type {
  GatewayBenchmarkProfile,
  GatewayBypassInput,
  GatewayBypassResult,
  GatewayContextEvidenceLink,
  GatewayEnvelopeInput,
  GatewayEnvelopeResult,
  GatewayEvidenceLinks,
  GatewayModeInput,
  GatewayModeResolution,
  GatewayProposalEvidenceLink,
  GatewayProviderEvidenceLink,
  GatewaySessionEvidenceLink
} from "./gateway/index.js";
export {
  evaluateGatewayEnvelope,
  linkGatewayEvidence,
  resolveGatewayMode
} from "./gateway/index.js";
export type {
  AttachmentStatus,
  BackupAuditEvent,
  BackupResult,
  BackupStorageSnapshot,
  CreateBackupMetadataInput,
  CreateOperationsStatusInput,
  CreatePortableBundleInput,
  OperationsBackupReadiness,
  OperationsDataPathStatus,
  OperationsEmbeddingStatus,
  OperationsHostPrereqStatus,
  OperationsProfileScopeStatus,
  OperationsProfileStatusInput,
  OperationsProviderStatusInput,
  OperationsSecretRefReport,
  OperationsSecretRefStatus,
  OperationsStatusReport,
  PortableBackupMetadata,
  PortableBundle,
  PortableBundleIntegrity,
  PortableBundleManifest,
  PortableBundleManifestCounts,
  PortableBundleMetadata,
  PortableBundlePayload,
  PortableProfileScopeKind,
  PortableProfileScopeSnapshot,
  PortableRuntimeArtifactExclusion,
  PortableSourceRef,
  ProviderPosture,
  RuntimeArtifactKind,
  SecretRefResolutionState as OperationsSecretRefResolutionState,
  SecretRefSourceType as OperationsSecretRefSourceType
} from "./operations/index.js";
export {
  createBackupMetadata,
  createOperationsStatusReport,
  createPortableBundle,
  deriveProviderPosture,
  hashPortablePayload,
  validatePortableBundleForImport
} from "./operations/index.js";
