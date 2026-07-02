/**
 * @packageDocumentation
 * `@do-soul/alaya-protocol` is the zod-only schema leaf of Do-SOUL Alaya: the
 * shared contracts every other package depends on, with no runtime logic of its
 * own. Schemas are grouped by domain:
 *
 * - `soul` — memory ontology: entries, evidence/synthesis capsules, claims,
 *   recall candidates/policy, governance, karma, lifecycle, status models.
 * - `workspace` — workspace and workspace-file contracts.
 * - `runtime` — run and hot-state contracts.
 * - `signals` — candidate memory signals proposed by agents/garden.
 * - `events` — event-log entry shapes.
 * - `engine` — engine-facing contracts.
 * - `conversation` — conversation and context-lens surfaces.
 * - `tools` — MCP tool catalog contracts.
 * - `workers` — background-worker contracts.
 * - `config` — configuration schemas.
 * - `shared` — primitives shared across the above.
 */
export * from "./workspace/workspace.js";
export * from "./workspace/workspace-files.js";
export * from "./runtime/run.js";
export * from "./runtime/run-hot-state.js";
export * from "./signals/candidate-memory-signal.js";
export * from "./soul/object-kind.js";
export * from "./soul/lifecycle.js";
export * from "./soul/status-model.js";
export * from "./soul/envelope.js";
export * from "./soul/base-types.js";
export * from "./soul/governance-subject.js";
export * from "./soul/evidence-capsule.js";
export * from "./soul/memory-entry.js";
export * from "./soul/global-memory-entry.js";
export * from "./soul/synthesis-capsule.js";
export * from "./soul/claim-form.js";
export * from "./soul/factual-policy-boundary.js";
export * from "./soul/memory-constants.js";
export * from "./soul/karma-event.js";
export * from "./soul/task-object-surface.js";
export * from "./soul/staged-warning.js";
export * from "./soul/resolution.js";
export * from "./soul/recall-candidate.js";
export * from "./soul/recall-policy.js";
export * from "./soul/fts-search-policy.js";
export * from "./soul/active-constraints-policy.js";
export * from "./soul/embedding-status.js";
export * from "./soul/context-lens.js";
export * from "./soul/verification.js";
export * from "./soul/output-shaping.js";
export * from "./soul/green-status.js";
export * from "./soul/security-status.js";
export * from "./soul/governance-snapshot.js";
export * from "./soul/governance-lease.js";
export * from "./soul/bankruptcy.js";
export * from "./soul/budget-snapshot.js";
export * from "./soul/garden-backlog-snapshot.js";
export * from "./soul/degradation.js";
export * from "./soul/proposal.js";
export * from "./soul/session-override.js";
export * from "./soul/promotion-gate.js";
export * from "./soul/handoff-gap.js";
export * from "./soul/dynamics-constants.js";
export * from "./soul/memory-graph.js";
export * from "./soul/edge-proposal.js";
export * from "./soul/graph.js";
export * from "./soul/path-relation.js";
export * from "./soul/bootstrapping.js";
export * from "./soul/path-graph-snapshot.js";
export * from "./soul/soul-topology.js";
export * from "./soul/activation-candidate.js";
export * from "./soul/manifestation-budget.js";
export * from "./soul/execution-stance.js";
export * from "./soul/extension-descriptors.js";
export * from "./soul/extension-descriptor-parsers.js";
export * from "./soul/canonical-alias.js";
export * from "./soul/path-anchor-identity.js";
export * from "./soul/path-anchor-normalization.js";
export * from "./soul/compute-routing.js";
export * from "./soul/consolidation-types.js";
export * from "./soul/surface-drift.js";
export * from "./soul/mcp-types.js";
export * from "./soul/trust-state.js";
export * from "./soul/orphan-radar.js";
export * from "./soul/slot.js";
export * from "./soul/surface.js";
export * from "./soul/conflict-matrix.js";
export * from "./soul/cross-cutting.js";
export * from "./soul/project-mapping.js";
export * from "./soul/garden-tier.js";
export * from "./soul/health-journal.js";
export * from "./soul/health-issue-group.js";
export * from "./soul/constitutional-fragment.js";
export * from "./workspace/files.js";
export * from "./tools/file-tools.js";
export * from "./config/app-config.js";
export * from "./events/event-log.js";
export * from "./events/workspace-run.js";
export * from "./events/signal.js";
export * from "./events/tool-worker.js";
export * from "./events/worker-runtime.js";
export * from "./events/obligation-trust-narrative.js";
export * from "./events/runtime-governance.js";
export * from "./events/compute-recall-garden.js";
export * from "./events/memory-governance.js";
export * from "./events/governance-resolution.js";
export * from "./events/slot.js";
export * from "./events/surface.js";
export * from "./events/recall-context.js";
export * from "./events/green-governance.js";
export * from "./events/budget.js";
export * from "./events/garden.js";
export * from "./events/graph-auditor.js";
export * from "./events/project-mapping.js";
export * from "./events/file-approval.js";
export * from "./events/event-log-orphan.js";
export * from "./events/message-delta.js";
export * from "./engine/engine-binding.js";
export * from "./engine/engine-port.js";
export * from "./conversation/conversation-message.js";
export * from "./conversation/conversation-tool-catalog.js";
export * from "./tools/tool-spec.js";
export * from "./tools/tool-governance.js";
export * from "./tools/tool-execution-record.js";
export * from "./runtime/runtime-run.js";
export * from "./workers/worker-dispatch.js";
export * from "./runtime/command-control.js";
export * from "./runtime/execution-stance.js";
export * from "./runtime/narrative-digest.js";
export * from "./runtime/deferred-obligation.js";
export * from "./runtime/dirty-state-dossier.js";
export * from "./runtime/strong-ref.js";
export * from "./workers/worker-trust.js";
export * from "./runtime/consolidation-trigger-budget.js";
export * from "./runtime/runtime-port.js";
export * from "./runtime/prompt-asset.js";
export * from "./workers/worker-safety-port.js";
export * from "./workers/zero-day-security.js";
export type { ToolGovernancePort } from "./tools/tool-governance-port.js";
export * from "./runtime/node-template.js";
export * from "./workers/auditor-ports.js";
export * from "./shared/read-error-message.js";
export {
  BoundedJsonObjectSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  PositiveIntSchema
} from "./shared/schema-primitives.js";
export {
  bindStandardConfigPatchResponse,
  bindStandardResponse,
  createConfigRouteResponseSchema,
  isZodValidationError,
  unwrapStandardResponseData
} from "./shared/standard-response.js";
export { ManifestationBudgetConfigRouteDataSchema } from "./soul/manifestation-budget.js";
