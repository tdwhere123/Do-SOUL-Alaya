import type {
  GovernanceResolutionPolicyClassification,
  StagedWarning
} from "@do-soul/alaya-protocol";

// invariant: closed set of routing outcomes the GovernancePolicy
// produces when classifying a StagedWarning. Mirrors the protocol
// enum so EventLog payloads share the same vocabulary.
// see also: packages/protocol/src/events/governance-resolution.ts
//   GovernanceResolutionPolicyClassificationSchema
export const GovernancePolicyOutcome = {
  ASK_NOW: "ask_now",
  APPLY_SILENTLY: "apply_silently",
  TRACK_ONLY: "track_only",
  INSPECT_LATER: "inspect_later"
} as const;

export type GovernancePolicyOutcome = GovernanceResolutionPolicyClassification;

export interface GovernancePolicyConfig {
  // invariant: per-turn ceiling on ask_now classifications. Overflow
  // falls through to inspect_later so a single recall cannot saturate
  // the agent's context.
  readonly askNowBudgetPerTurn: number;
}

export const DEFAULT_GOVERNANCE_POLICY_CONFIG: Readonly<GovernancePolicyConfig> =
  Object.freeze({
    askNowBudgetPerTurn: 3
  });

// invariant: per-turn counter shared across classifyWarning calls in
// the same agent turn. Caller MUST reset between turns; the helper
// `resetTurn` is provided.
export class GovernancePolicy {
  private askNowEmitted = 0;
  private readonly config: GovernancePolicyConfig;

  public constructor(config: GovernancePolicyConfig = DEFAULT_GOVERNANCE_POLICY_CONFIG) {
    this.config = config;
  }

  public resetTurn(): void {
    this.askNowEmitted = 0;
  }

  // invariant: classifyWarning is deterministic on (warning, current
  // ask_now budget remaining). It does NOT mutate the warning. The
  // routing rules below are exhaustive over StagedWarning.severity x
  // StagedWarning.kind.
  public classifyWarning(warning: StagedWarning): GovernancePolicyOutcome {
    const base = this.classifyBase(warning);
    if (base !== GovernancePolicyOutcome.ASK_NOW) {
      return base;
    }
    if (this.askNowEmitted >= this.config.askNowBudgetPerTurn) {
      return GovernancePolicyOutcome.INSPECT_LATER;
    }
    this.askNowEmitted += 1;
    return GovernancePolicyOutcome.ASK_NOW;
  }

  public askNowRemaining(): number {
    return Math.max(0, this.config.askNowBudgetPerTurn - this.askNowEmitted);
  }

  private classifyBase(warning: StagedWarning): GovernancePolicyOutcome {
    if (warning.severity === "blocking") {
      return GovernancePolicyOutcome.ASK_NOW;
    }
    if (warning.severity === "warning") {
      if (warning.kind === "contradiction_pending" || warning.kind === "policy_violation") {
        return GovernancePolicyOutcome.ASK_NOW;
      }
      if (warning.kind === "supersede_candidate") {
        return GovernancePolicyOutcome.APPLY_SILENTLY;
      }
      return GovernancePolicyOutcome.INSPECT_LATER;
    }
    if (warning.kind === "supersede_candidate") {
      return GovernancePolicyOutcome.APPLY_SILENTLY;
    }
    if (warning.kind === "low_confidence" || warning.kind === "evidence_missing") {
      return GovernancePolicyOutcome.TRACK_ONLY;
    }
    return GovernancePolicyOutcome.INSPECT_LATER;
  }
}
