/**
 * @packageDocumentation
 * `@do-soul/alaya-protocol` is the zod-only schema leaf of Do-SOUL Alaya: the
 * shared contracts every other package depends on, with no runtime logic of its
 * own. Schemas are grouped by domain:
 *
 * - `memory` — entries, capsules, claims, karma, graph, and status models.
 * - `evidence` — evidence capsules, fact frames, and formation completeness.
 * - `relations` — graph, path, edge-proposal, and semantic-factor contracts.
 * - `recall` — candidates, policy, FTS, field-contract, and manifestation.
 * - `governance` — proposals, constraints, green/security status, verification.
 * - `garden` — garden tier, backlog, bootstrapping, and extract constants.
 * - `surfaces` — MCP types, slots, project mapping, and extension descriptors.
 * - `lifecycle` — budget, orphan radar, handoff, session override, dynamics.
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
export * from "./memory/object-kind.js";
export * from "./memory/lifecycle.js";
export * from "./memory/status-model.js";
export * from "./memory/envelope.js";
export * from "./memory/base-types.js";
export * from "./governance/governance-subject.js";
export * from "./evidence/evidence-capsule.js";
export * from "./evidence/associative-fact-frame.js";
export * from "./relations/open-semantic-factor-graph.js";
export * from "./recall/open-semantic-factor-activation-state.js";
export * from "./relations/open-semantic-structural-role.js";
export * from "./recall/query-osf-semantic-completeness.js";
export * from "./evidence/formation/evidence-osf-semantic-completeness.js";
export * from "./recall/kind-projection.js";
export * from "./recall/query-osf-facet-obligation.js";
export * from "./recall/field-contract/index.js";
export * from "./evidence/verified-user-assertion-receipt.js";
export * from "./garden/garden-source-turn-fallback-receipt.js";
export * from "./memory/memory-entry.js";
export * from "./memory/memory-object-key.js";
export * from "./memory/global-memory-entry.js";
export * from "./memory/synthesis-capsule.js";
export * from "./memory/claim-form.js";
export * from "./governance/factual-policy-boundary.js";
export * from "./memory/memory-constants.js";
export * from "./memory/karma-event.js";
export * from "./surfaces/task-object-surface.js";
export * from "./governance/staged-warning.js";
export * from "./governance/resolution.js";
export * from "./recall/recall-candidate.js";
export * from "./recall/recall-policy.js";
export * from "./recall/fts-search-policy.js";
export * from "./governance/active-constraints-policy.js";
export * from "./recall/embedding-status.js";
export * from "./recall/context-lens.js";
export * from "./governance/verification.js";
export * from "./recall/output-shaping.js";
export * from "./governance/green-status.js";
export * from "./governance/security-status.js";
export * from "./governance/governance-snapshot.js";
export * from "./governance/governance-lease.js";
export * from "./governance/bankruptcy.js";
export * from "./lifecycle/budget-snapshot.js";
export * from "./garden/garden-backlog-snapshot.js";
export * from "./recall/degradation.js";
export * from "./governance/proposal.js";
export * from "./lifecycle/session-override.js";
export * from "./governance/promotion-gate.js";
export * from "./lifecycle/handoff-gap.js";
export * from "./lifecycle/dynamics-constants.js";
export * from "./memory/memory-graph.js";
export * from "./relations/edge-proposal.js";
export * from "./relations/graph.js";
export * from "./relations/path-relation.js";
export * from "./relations/relation-assertion.js";
export * from "./garden/bootstrapping.js";
export * from "./relations/path-graph-snapshot.js";
export * from "./relations/soul-topology.js";
export * from "./recall/activation-candidate.js";
export * from "./recall/manifestation-budget.js";
export * from "./evidence/source-grounding-defer.js";
export * from "./lifecycle/execution-stance.js";
export * from "./surfaces/extension-descriptors.js";
export * from "./surfaces/extension-descriptor-parsers.js";
export * from "./memory/canonical-alias.js";
export * from "./relations/path-anchor-identity.js";
export * from "./relations/time-concern-window-digest.js";
export * from "./relations/path-anchor-normalization.js";
export * from "./recall/compute-routing.js";
export * from "./lifecycle/consolidation-types.js";
export * from "./surfaces/surface-drift.js";
export * from "./surfaces/mcp-types.js";
export * from "./governance/trust-state.js";
export * from "./lifecycle/orphan-radar.js";
export * from "./surfaces/slot.js";
export * from "./surfaces/surface.js";
export * from "./governance/conflict-matrix.js";
export * from "./lifecycle/cross-cutting.js";
export * from "./surfaces/project-mapping.js";
export * from "./garden/garden-tier.js";
export * from "./garden/garden-extract-constants.js";
export * from "./memory/health-journal.js";
export * from "./memory/health-issue-group.js";
export * from "./governance/constitutional-fragment.js";
export * from "./workspace/files.js";
export * from "./tools/file-tools.js";
export * from "./config/app-config.js";
export * from "./events/event-log.js";
export * from "./events/field-generation.js";
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
export * from "./recall/selection/capture/capture-execution.js";
export * from "./recall/selection/capture/capture-receipt-structures.js";
export * from "./recall/selection/capture/canonical-selection-receipt.js";
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
export { AlayaError, type AlayaErrorOptions } from "./shared/alaya-error.js";
export { deepFreeze } from "./shared/deep-freeze.js";
export {
  BOUNDED_JSON_OBJECT_MAX_CHARS,
  BoundedJsonObjectSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  PREFERENCE_FACT_MAX_CHARS,
  PositiveIntSchema
} from "./shared/schema-primitives.js";
export {
  bindStandardConfigPatchResponse,
  bindStandardResponse,
  createConfigRouteResponseSchema,
  isZodValidationError,
  unwrapStandardResponseData
} from "./shared/standard-response.js";
export { ManifestationBudgetConfigRouteDataSchema } from "./recall/manifestation-budget.js";
