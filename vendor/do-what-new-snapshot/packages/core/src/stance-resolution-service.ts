import { randomUUID } from "node:crypto";
import {
  ExecutionConservatismOrder,
  ExecutionStancePolicySchema,
  ExecutionStanceResolutionSchema,
  ExecutionVerificationAttentionOrder,
  ManifestationPreference,
  PhaseCEventType,
  StancePolicyEvaluatedPayloadSchema,
  StanceResolutionChangedPayloadSchema,
  type ActivationCandidate,
  type EventLogEntry,
  type ExecutionConservatism,
  type ExecutionStanceModelRef,
  type ExecutionStancePolicy,
  type ExecutionStanceResolution,
  type ExecutionVerificationAttention
} from "@do-what/protocol";
import { loadOrDefaultWithWorkspaceGuard } from "./shared/load-or-default-with-workspace-guard.js";
import { normalizeUnit } from "./shared/normalize-unit.js";
import { validateActivationCandidates } from "./shared/validated-activation-candidates.js";

export interface StancePolicyProviderPort {
  getPolicy(workspaceId: string): Promise<Readonly<ExecutionStancePolicy> | null>;
}

export interface StanceResolutionEventLogWriterPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
}

export interface StanceResolutionDependencies {
  readonly stancePolicyProvider: StancePolicyProviderPort;
  readonly eventLogWriter: StanceResolutionEventLogWriterPort;
  readonly now?: () => string;
  readonly generateResolutionId?: () => string;
}

export interface ResolveStanceParams {
  readonly workspaceId: string;
  readonly runId: string;
  readonly candidates: readonly Readonly<ActivationCandidate>[];
  readonly modelRef?: ExecutionStanceModelRef | null;
}

const DEFAULT_VERIFICATION_ATTENTION: ExecutionVerificationAttention = "standard";
const DEFAULT_CONSERVATISM: ExecutionConservatism = "balanced";
// Each resolution rewrites a fresh entity snapshot, so its append-only EventLog
// stream always starts at revision 0 for both policy-evaluated and resolution-changed.
const INITIAL_STANCE_EVENT_REVISION = 0;

export class StanceResolutionService {
  public constructor(private readonly deps: StanceResolutionDependencies) {}

  public async resolve(params: ResolveStanceParams): Promise<Readonly<ExecutionStanceResolution>> {
    const resolvedAt = this.now();
    const { loaded: loadedPolicy, value: policy } = await loadOrDefaultWithWorkspaceGuard({
      workspaceId: params.workspaceId,
      load: () => this.deps.stancePolicyProvider.getPolicy(params.workspaceId),
      parse: (value) => ExecutionStancePolicySchema.parse(value),
      createDefault: () => createImplicitPolicy(params.workspaceId, resolvedAt),
      label: "Stance policy"
    });

    const validatedCandidates = validateActivationCandidates(params.candidates);
    const contributions = collectContributions(validatedCandidates, params.workspaceId, params.runId);
    const verificationAttention = clampAtMinimum(
      advanceVerificationAttention(
        raiseVerificationAttentionToMinimum(
          policy.default_verification_attention,
          policy.minimum_verification_attention
        ),
        resolveLevelDelta(contributions.verificationScore)
      ),
      policy.minimum_verification_attention,
      ExecutionVerificationAttentionOrder
    );
    const conservatism = clampAtMinimum(
      advanceConservatism(
        raiseConservatismToMinimum(policy.default_conservatism, policy.minimum_conservatism),
        resolveLevelDelta(contributions.conservatismScore)
      ),
      policy.minimum_conservatism,
      ExecutionConservatismOrder
    );
    const resolution = ExecutionStanceResolutionSchema.parse({
      resolution_id: this.generateResolutionId(),
      workspace_id: params.workspaceId,
      run_id: params.runId,
      verification_attention: verificationAttention,
      conservatism,
      contributing_candidate_ids: contributions.contributingCandidateIds,
      model_ref: params.modelRef ?? null,
      resolved_at: resolvedAt
    });

    await Promise.all([
      this.deps.eventLogWriter.append({
        event_type: PhaseCEventType.STANCE_POLICY_EVALUATED,
        entity_type: "stance_policy",
        entity_id: loadedPolicy?.policy_id ?? `${params.workspaceId}:implicit-default`,
        workspace_id: params.workspaceId,
        run_id: params.runId,
        caused_by: "deterministic_rule",
        revision: INITIAL_STANCE_EVENT_REVISION,
        payload_json: StancePolicyEvaluatedPayloadSchema.parse({
          workspace_id: params.workspaceId,
          policy_id: loadedPolicy?.policy_id ?? null,
          default_verification_attention: policy.default_verification_attention,
          default_conservatism: policy.default_conservatism,
          evaluated_at: resolvedAt
        })
      }),
      this.deps.eventLogWriter.append({
        event_type: PhaseCEventType.STANCE_RESOLUTION_CHANGED,
        entity_type: "stance_resolution",
        entity_id: resolution.resolution_id,
        workspace_id: params.workspaceId,
        run_id: params.runId,
        caused_by: "deterministic_rule",
        revision: INITIAL_STANCE_EVENT_REVISION,
        payload_json: StanceResolutionChangedPayloadSchema.parse({
          resolution_id: resolution.resolution_id,
          workspace_id: params.workspaceId,
          run_id: params.runId,
          verification_attention: resolution.verification_attention,
          conservatism: resolution.conservatism,
          contributing_candidate_count: resolution.contributing_candidate_ids.length,
          has_model_ref: resolution.model_ref !== null,
          resolved_at: resolvedAt
        })
      })
    ]);

    return resolution;
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private generateResolutionId(): string {
    return this.deps.generateResolutionId?.() ?? `stance-resolution-${randomUUID()}`;
  }
}

function createImplicitPolicy(
  workspaceId: string,
  nowIso: string
): Readonly<ExecutionStancePolicy> {
  return ExecutionStancePolicySchema.parse({
    policy_id: `${workspaceId}:implicit-default`,
    workspace_id: workspaceId,
    default_verification_attention: DEFAULT_VERIFICATION_ATTENTION,
    default_conservatism: DEFAULT_CONSERVATISM,
    minimum_verification_attention: DEFAULT_VERIFICATION_ATTENTION,
    minimum_conservatism: DEFAULT_CONSERVATISM,
    created_at: nowIso,
    updated_at: nowIso
  });
}

function collectContributions(
  candidates: readonly Readonly<ActivationCandidate>[],
  workspaceId: string,
  runId: string
) {
  const contributingCandidateIds: string[] = [];
  let verificationScore = 0;
  let conservatismScore = 0;

  for (const candidate of candidates) {
    if (candidate.workspace_id !== workspaceId || candidate.run_id !== runId) {
      continue;
    }

    if (
      candidate.effect_vector_snapshot.default_manifestation_preference !==
      ManifestationPreference.STANCE_BIAS
    ) {
      continue;
    }

    const weight = normalizeUnit(candidate.pressure) * normalizeUnit(candidate.confidence);
    const verificationContribution =
      normalizeUnit(candidate.effect_vector_snapshot.unfinishedness_bias) * weight;
    const conservatismContribution =
      normalizeUnit(candidate.effect_vector_snapshot.verification_bias) * weight;

    if (verificationContribution <= 0 && conservatismContribution <= 0) {
      continue;
    }

    contributingCandidateIds.push(candidate.candidate_id);
    verificationScore += verificationContribution;
    conservatismScore += conservatismContribution;
  }

  return {
    contributingCandidateIds: [...new Set(contributingCandidateIds)],
    verificationScore,
    conservatismScore
  } as const;
}

function resolveLevelDelta(score: number): 0 | 1 | 2 | 3 {
  if (score >= 1.6) {
    return 3;
  }

  if (score >= 0.8) {
    return 2;
  }

  if (score >= 0.35) {
    return 1;
  }

  return 0;
}

function raiseVerificationAttentionToMinimum(
  value: ExecutionVerificationAttention,
  minimum: ExecutionVerificationAttention
): ExecutionVerificationAttention {
  return clampAtMinimum(value, minimum, ExecutionVerificationAttentionOrder);
}

function raiseConservatismToMinimum(
  value: ExecutionConservatism,
  minimum: ExecutionConservatism
): ExecutionConservatism {
  return clampAtMinimum(value, minimum, ExecutionConservatismOrder);
}

function advanceVerificationAttention(
  value: ExecutionVerificationAttention,
  levels: number
): ExecutionVerificationAttention {
  return advanceLevel(value, levels, ExecutionVerificationAttentionOrder);
}

function advanceConservatism(
  value: ExecutionConservatism,
  levels: number
): ExecutionConservatism {
  return advanceLevel(value, levels, ExecutionConservatismOrder);
}

function advanceLevel<T extends string>(
  value: T,
  levels: number,
  order: readonly T[]
): T {
  const index = order.indexOf(value);
  const maxIndex = order.length - 1;

  if (index < 0 || levels <= 0 || maxIndex < 0) {
    return value;
  }

  return order[Math.min(maxIndex, index + levels)] ?? value;
}

function clampAtMinimum<T extends string>(
  value: T,
  minimum: T,
  order: readonly T[]
): T {
  const valueIndex = order.indexOf(value);
  const minimumIndex = order.indexOf(minimum);

  if (valueIndex < 0 || minimumIndex < 0) {
    return value;
  }

  return valueIndex < minimumIndex ? order[minimumIndex] : value;
}
