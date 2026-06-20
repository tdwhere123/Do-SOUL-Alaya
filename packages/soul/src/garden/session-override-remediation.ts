import {
  ClaimKind,
  EnforcementLevel,
  MemoryDimension,
  OriginTier,
  GreenGovernanceEventType,
  PrecedenceBasis,
  ScopeClass,
  SoulSessionOverridePromotedPayloadSchema,
  SourceKind,
  StorageTier,
  type ClaimForm,
  type ClaimKind as ClaimKindValue,
  type EventLogEntry,
  type MemoryDimension as MemoryDimensionValue,
  type MemoryEntry,
  type SessionOverride
} from "@do-soul/alaya-protocol";

export type PromotionOutcome = "durable" | "candidate" | "pending_review" | "not_promoted";

type PromotionMemoryInput = Omit<
  MemoryEntry,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "storage_tier"
  | "activation_score"
  | "retention_score"
  | "manifestation_state"
  | "retention_state"
  | "decay_profile"
  | "confidence"
  | "last_used_at"
  | "last_hit_at"
  | "reinforcement_count"
  | "contradiction_count"
  | "superseded_by"
> & {
  readonly storage_tier?: MemoryEntry["storage_tier"];
};

type PromotionClaimInput = Omit<
  ClaimForm,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "governance_subject"
  | "claim_status"
> & {
  readonly governance_subject_domain: string;
  readonly governance_subject_qualifiers?: Record<string, string>;
};

interface PromotionCreatedObject {
  readonly object_kind: string;
  readonly object_id: string;
}

export interface SessionOverrideRemediationMemoryPort {
  create(input: PromotionMemoryInput): Promise<PromotionCreatedObject>;
}

export interface SessionOverrideRemediationClaimPort {
  create(input: PromotionClaimInput): Promise<PromotionCreatedObject>;
}

export interface SessionOverrideRemediationTargetObjectResolverPort {
  resolveDimension(targetObject: string): Promise<MemoryDimensionValue | null>;
}

export interface SessionOverrideRemediationWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}

export interface SessionOverrideRemediationEventLogPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<EventLogEntry>;
  hasSessionOverridePromotion(overrideId: string): Promise<boolean>;
  countDistinctAppliedSessionOverrideRuns(query: {
    readonly workspaceId: string;
    readonly targetObject: string;
    readonly correction: string;
  }): Promise<number>;
}

export interface SessionOverrideRemediationDependencies {
  readonly memoryService: SessionOverrideRemediationMemoryPort;
  readonly claimService: SessionOverrideRemediationClaimPort;
  readonly eventLogRepo: SessionOverrideRemediationEventLogPort;
  readonly targetObjectResolver?: SessionOverrideRemediationTargetObjectResolverPort;
  readonly now?: () => string;
  readonly warn?: SessionOverrideRemediationWarnPort;
}

export class SessionOverrideRemediation {
  private readonly now: () => string;
  private readonly warn: SessionOverrideRemediationWarnPort;
  private hasWarnedMissingTargetObjectResolver = false;
  private hasWarnedFallbackTargetDimension = false;

  public constructor(private readonly dependencies: SessionOverrideRemediationDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? ((message, meta) => console.warn(message, meta));
  }

  public async evaluate(params: {
    readonly override: Readonly<SessionOverride>;
    readonly workspaceId: string;
    readonly runId: string;
    readonly dimension?: MemoryDimensionValue;
    readonly triggerConditions?: readonly string[];
  }): Promise<PromotionOutcome> {
    const occurredAt = this.now();
    const dimension = await this.resolvePromotionDimension(params.dimension, params.override.target_object);
    const baseConditionsPass = this.checkBaseConditions(params.override);
    const triggerConditionsPass = this.checkTriggerConditions(params.triggerConditions ?? []);

    const outcome =
      !baseConditionsPass || !triggerConditionsPass
        ? "not_promoted"
        : await this.applyDimensionStrategy(dimension, params.override, params.workspaceId, params.runId);

    await this.appendOutcomeEvent(params.override, params.workspaceId, params.runId, dimension, outcome, occurredAt);

    return outcome;
  }

  public async evaluatePending(params: {
    readonly overrides: readonly Readonly<SessionOverride>[];
    readonly workspaceId: string;
    readonly runId: string;
  }): Promise<void> {
    for (const override of params.overrides) {
      if (await this.hasPromotionAudit(override.runtime_id)) {
        continue;
      }

      await this.evaluate({
        override,
        workspaceId: params.workspaceId,
        runId: params.runId,
        triggerConditions: await this.inferTriggerConditions(override, params.workspaceId)
      });
    }
  }

  private checkBaseConditions(override: Readonly<SessionOverride>): boolean {
    return (
      hasLocatableTarget(override) &&
      hasCorrectionEvidence(override) &&
      isNotOneOff(override) &&
      hasNoCoreAmbiguity(override)
    );
  }

  private checkTriggerConditions(triggerConditions: readonly string[]): boolean {
    return triggerConditions.some((condition) => condition.trim().length > 0);
  }

  private async applyDimensionStrategy(
    dimension: MemoryDimensionValue,
    override: Readonly<SessionOverride>,
    workspaceId: string,
    runId: string
  ): Promise<PromotionOutcome> {
    switch (dimension) {
      case MemoryDimension.PREFERENCE:
        await this.dependencies.memoryService.create({
          created_by: "system",
          dimension,
          source_kind: SourceKind.USER,
          formation_kind: "explicit",
          scope_class: inferScopeClass(override.target_object),
          content: override.correction,
          domain_tags: ["session_override"],
          evidence_refs: collectEvidenceRefs(override),
          workspace_id: workspaceId,
          run_id: runId,
          surface_id: null,
          storage_tier: StorageTier.HOT
        });
        return "durable";
      case MemoryDimension.FACT:
      case MemoryDimension.CONSTRAINT:
      case MemoryDimension.PROCEDURE:
        await this.dependencies.claimService.create({
          created_by: "system",
          governance_subject_domain: "session_override",
          governance_subject_qualifiers: {
            target_object: override.target_object,
            workspace_id: workspaceId,
            run_id: runId
          },
          claim_kind: toClaimKind(dimension),
          scope_class: inferScopeClass(override.target_object),
          enforcement_level: toClaimEnforcementLevel(dimension),
          origin_tier: OriginTier.USER_EXPLICIT,
          precedence_basis: PrecedenceBasis.USER_OVERRIDE,
          proposition_digest: override.correction,
          evidence_refs: collectEvidenceRefs(override),
          source_object_refs: [override.target_object],
          workspace_id: workspaceId
        });
        return "candidate";
      case MemoryDimension.HAZARD:
        return "pending_review";
      default:
        return "not_promoted";
    }
  }

  private async appendOutcomeEvent(
    override: Readonly<SessionOverride>,
    workspaceId: string,
    runId: string,
    dimension: MemoryDimensionValue,
    outcome: PromotionOutcome,
    occurredAt: string
  ): Promise<void> {
    await this.dependencies.eventLogRepo.append({
      event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
      entity_type: "session_override",
      entity_id: override.runtime_id,
      workspace_id: workspaceId,
      run_id: runId,
      caused_by: "system",
      payload_json: SoulSessionOverridePromotedPayloadSchema.parse({
        override_id: override.runtime_id,
        target_object: override.target_object.trim().length === 0 ? "unlocatable_target" : override.target_object,
        dimension,
        promotion_outcome: outcome,
        occurred_at: occurredAt
      })
    });
  }

  private async hasPromotionAudit(overrideId: string): Promise<boolean> {
    return await this.dependencies.eventLogRepo.hasSessionOverridePromotion(overrideId);
  }

  private async resolvePromotionDimension(
    explicitDimension: MemoryDimensionValue | undefined,
    targetObject: string
  ): Promise<MemoryDimensionValue> {
    if (explicitDimension !== undefined) {
      return explicitDimension;
    }

    if (this.dependencies.targetObjectResolver === undefined) {
      this.warnMissingTargetObjectResolver(targetObject);
      return inferPromotionDimensionFromTargetObject(targetObject);
    }

    const resolvedDimension = await this.dependencies.targetObjectResolver.resolveDimension(targetObject);

    if (resolvedDimension !== null) {
      return resolvedDimension;
    }

    this.warnFallbackTargetDimension(targetObject);
    return inferPromotionDimensionFromTargetObject(targetObject);
  }

  private async inferTriggerConditions(
    override: Readonly<SessionOverride>,
    workspaceId: string
  ): Promise<readonly string[]> {
    const conditions: string[] = [];

    if (/\b(always|remember|from now on|default to)\b/i.test(override.correction)) {
      conditions.push("explicit_long_term_intent");
    }

    if (await this.hasRecurringOverride(override, workspaceId)) {
      conditions.push("repeated_override");
    }

    return Object.freeze(conditions);
  }

  private async hasRecurringOverride(
    override: Readonly<SessionOverride>,
    workspaceId: string
  ): Promise<boolean> {
    const recurringRuns = await this.dependencies.eventLogRepo.countDistinctAppliedSessionOverrideRuns({
      workspaceId,
      targetObject: override.target_object,
      correction: override.correction
    });
    return recurringRuns >= 2;
  }

  private warnMissingTargetObjectResolver(targetObject: string): void {
    if (this.hasWarnedMissingTargetObjectResolver) {
      return;
    }

    this.hasWarnedMissingTargetObjectResolver = true;
    this.warn(
      "[SessionOverrideRemediation] targetObjectResolver missing; falling back to target-object heuristics.",
      { targetObject }
    );
  }

  private warnFallbackTargetDimension(targetObject: string): void {
    if (this.hasWarnedFallbackTargetDimension) {
      return;
    }

    this.hasWarnedFallbackTargetDimension = true;
    this.warn(
      "[SessionOverrideRemediation] targetObjectResolver returned no dimension; using heuristic fallback.",
      { targetObject }
    );
  }
}

function inferPromotionDimensionFromTargetObject(targetObject: string): MemoryDimensionValue {
  const normalized = targetObject.trim().toLowerCase();

  if (normalized.includes("hazard") || normalized.includes("safety")) {
    return MemoryDimension.HAZARD;
  }

  if (normalized.includes("constraint")) {
    return MemoryDimension.CONSTRAINT;
  }

  if (normalized.includes("procedure")) {
    return MemoryDimension.PROCEDURE;
  }

  if (normalized.includes("fact")) {
    return MemoryDimension.FACT;
  }

  return MemoryDimension.PREFERENCE;
}

function collectEvidenceRefs(override: Readonly<SessionOverride>): readonly string[] {
  return override.derived_from === null ? [] : [override.derived_from];
}

function inferScopeClass(targetObject: string): MemoryEntry["scope_class"] {
  const normalized = targetObject.trim().toLowerCase();

  if (normalized.includes("global_core")) {
    return ScopeClass.GLOBAL_CORE;
  }

  if (normalized.includes("global_domain")) {
    return ScopeClass.GLOBAL_DOMAIN;
  }

  return ScopeClass.PROJECT;
}

function hasLocatableTarget(override: Readonly<SessionOverride>): boolean {
  return override.target_object.trim().length > 0;
}

function hasCorrectionEvidence(override: Readonly<SessionOverride>): boolean {
  return override.derived_from !== null && override.derived_from.trim().length > 0;
}

function isNotOneOff(override: Readonly<SessionOverride>): boolean {
  return !/(just this once|for this turn|temporar(?:y|ily)|one[- ]off)/i.test(override.correction);
}

function hasNoCoreAmbiguity(override: Readonly<SessionOverride>): boolean {
  return !/(maybe|unclear|not sure|or maybe)/i.test(override.correction);
}

function toClaimKind(dimension: MemoryDimensionValue): ClaimKindValue {
  switch (dimension) {
    case MemoryDimension.PROCEDURE:
      return ClaimKind.PROCEDURE;
    case MemoryDimension.FACT:
      return ClaimKind.FACTUAL_POLICY;
    case MemoryDimension.CONSTRAINT:
    default:
      return ClaimKind.CONSTRAINT;
  }
}

function toClaimEnforcementLevel(dimension: MemoryDimensionValue): ClaimForm["enforcement_level"] {
  switch (dimension) {
    case MemoryDimension.PROCEDURE:
      return EnforcementLevel.PREFERRED;
    case MemoryDimension.FACT:
    case MemoryDimension.CONSTRAINT:
    default:
      return EnforcementLevel.STRICT;
  }
}
