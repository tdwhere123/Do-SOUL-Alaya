import { randomUUID } from "node:crypto";
import { clamp01 } from "../shared/clamp.js";
import {
  BankruptcyAction,
  BankruptcyDossierSchema,
  BankruptcyKind,
  BankruptcyTriggerKind,
  BudgetBankruptcyStateSchema,
  ProposalOptionKind,
  RuntimeMode,
  type BankruptcyAction as BankruptcyActionValue,
  type BankruptcyDossier,
  type BankruptcyKind as BankruptcyKindValue,
  type BudgetBankruptcyState,
  type Proposal,
  type ProposalOption,
  type RuntimeMode as RuntimeModeValue
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import type {
  ActiveBankruptcyKind,
  BudgetBankruptcyDeclareParams
} from "./budget-bankruptcy-service-types.js";

export function parseState(
  value: BudgetBankruptcyState
): Readonly<BudgetBankruptcyState> {
  try {
    return Object.freeze(BudgetBankruptcyStateSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid budget bankruptcy state payload", {
      cause: error
    });
  }
}

export function parseDossier(
  value: BankruptcyDossier
): Readonly<BankruptcyDossier> {
  try {
    return Object.freeze(BankruptcyDossierSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid bankruptcy dossier payload", {
      cause: error
    });
  }
}

export function parseRequiredActions(
  value: readonly BankruptcyActionValue[]
): readonly BankruptcyActionValue[] {
  if (value.length === 0) {
    throw new CoreError("VALIDATION", "requiredActions must contain at least one action");
  }

  return Object.freeze(value.map((action) => parseBankruptcyAction(action)));
}

export function determineBankruptcyKind(
  params: BudgetBankruptcyDeclareParams
): ActiveBankruptcyKind {
  if (
    params.triggerKind === BankruptcyTriggerKind.SAFETY_GUARD ||
    params.triggerKind === BankruptcyTriggerKind.STRICT_CONFLICT
  ) {
    return BankruptcyKind.HARD;
  }

  if (params.droppedCandidates.some((candidate) => params.protectedConstraints.includes(candidate))) {
    return BankruptcyKind.HARD;
  }

  const hasAutoPath =
    params.requiredActions.includes(BankruptcyAction.COMPRESS) ||
    params.requiredActions.includes(BankruptcyAction.DEFER) ||
    params.triggerKind === BankruptcyTriggerKind.TOKEN_OVERFLOW ||
    params.triggerKind === BankruptcyTriggerKind.MISSING_VERIFICATION;

  return hasAutoPath ? BankruptcyKind.SOFT : BankruptcyKind.HARD;
}

export function computePressureRatio(
  params: BudgetBankruptcyDeclareParams,
  kind: ActiveBankruptcyKind
): number {
  if (kind === BankruptcyKind.HARD) {
    return 1;
  }

  if (
    typeof params.tokensUsed === "number" &&
    typeof params.maxTotalTokens === "number" &&
    params.maxTotalTokens > 0
  ) {
    return clamp01(params.tokensUsed / params.maxTotalTokens);
  }

  return pressureRatioForKind(kind);
}

export function buildProposalOptions(
  params: BudgetBankruptcyDeclareParams,
  kind: ActiveBankruptcyKind,
  dossier: Readonly<BankruptcyDossier>
): readonly Readonly<ProposalOption>[] {
  const options: ProposalOption[] = [];
  appendSoftContextOptions(options, params, dossier);
  appendVerificationDeferralOption(options, params, dossier);
  appendRiskOptions(options, params, kind, dossier);
  ensureFallbackProposalOption(options, dossier);
  return Object.freeze(options.map((option) => Object.freeze(option)));
}

export function getAutoApplicableOption(
  proposal: Readonly<Proposal>
): Readonly<ProposalOption> | null {
  return (
    proposal.proposal_options.find(
      (option) =>
        option.preserves_protected_constraints && option.requires_confirmation === false
    ) ?? null
  );
}

export function deriveResolvedMode(
  currentMode: RuntimeModeValue,
  optionKind: ProposalOption["option_kind"]
): RuntimeModeValue {
  switch (optionKind) {
    case ProposalOptionKind.TRIM_SOFT_CONTEXT:
    case ProposalOptionKind.FREEZE_LOW_VALUE_COMPETITION:
    case ProposalOptionKind.DEFER_NONCRITICAL_VERIFICATION:
      return currentMode === RuntimeMode.MINIMAL ? RuntimeMode.MINIMAL : RuntimeMode.LEAN;
    case ProposalOptionKind.REQUEST_CONFIRMATION:
    case ProposalOptionKind.ABORT_HIGH_RISK_WRITE:
      return RuntimeMode.MINIMAL;
  }
}

export function ensureIsoDatetime(value: string, fieldName: string): string {
  const epoch = Date.parse(value);

  if (!Number.isFinite(epoch)) {
    throw new CoreError("VALIDATION", `${fieldName} must return a valid ISO timestamp`);
  }

  return new Date(epoch).toISOString();
}

export function normalizeOptionalTimestamp(
  value: string | null | undefined,
  fieldName: string
): string | null {
  const parsed = normalizeOptionalString(value);
  return parsed === null ? null : ensureIsoDatetime(parsed, fieldName);
}

function parseBankruptcyAction(
  value: BankruptcyActionValue
): BankruptcyActionValue {
  switch (value) {
    case BankruptcyAction.COMPRESS:
    case BankruptcyAction.DEFER:
    case BankruptcyAction.VERIFY:
    case BankruptcyAction.ARBITRATE:
    case BankruptcyAction.STOP:
      return value;
    default:
      throw new CoreError("VALIDATION", "Invalid bankruptcy action");
  }
}

export function pressureRatioForKind(kind: BankruptcyKindValue): number {
  switch (kind) {
    case BankruptcyKind.NONE:
      return 0;
    case BankruptcyKind.SOFT:
      return 0.5;
    case BankruptcyKind.HARD:
      return 1;
  }
}

function buildProposalOption(
  optionKind: ProposalOption["option_kind"],
  requiresConfirmation: boolean,
  droppedCandidates: readonly string[],
  unresolvedAfterApply: readonly string[]
): ProposalOption {
  return {
    option_id: `${optionKind}_${randomUUID()}`,
    option_kind: optionKind,
    preserves_protected_constraints: true,
    dropped_candidates: Object.freeze([...droppedCandidates]),
    unresolved_after_apply: Object.freeze([...unresolvedAfterApply]),
    requires_confirmation: requiresConfirmation
  };
}

export function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function appendSoftContextOptions(
  options: ProposalOption[],
  params: BudgetBankruptcyDeclareParams,
  dossier: Readonly<BankruptcyDossier>
): void {
  if (params.triggerKind === BankruptcyTriggerKind.SAFETY_GUARD) {
    return;
  }

  options.push(
    buildProposalOption(
      ProposalOptionKind.TRIM_SOFT_CONTEXT,
      false,
      dossier.dropped_candidates,
      dossier.unresolved_conflicts
    )
  );

  if (dossier.unresolved_conflicts.length > 0) {
    options.push(
      buildProposalOption(
        ProposalOptionKind.FREEZE_LOW_VALUE_COMPETITION,
        false,
        [],
        dossier.unresolved_conflicts
      )
    );
  }
}

function appendVerificationDeferralOption(
  options: ProposalOption[],
  params: BudgetBankruptcyDeclareParams,
  dossier: Readonly<BankruptcyDossier>
): void {
  if (
    params.triggerKind !== BankruptcyTriggerKind.MISSING_VERIFICATION &&
    !params.requiredActions.includes(BankruptcyAction.DEFER)
  ) {
    return;
  }

  options.push(
    buildProposalOption(
      ProposalOptionKind.DEFER_NONCRITICAL_VERIFICATION,
      false,
      dossier.dropped_candidates,
      dossier.unresolved_conflicts
    )
  );
}

function appendRiskOptions(
  options: ProposalOption[],
  params: BudgetBankruptcyDeclareParams,
  kind: ActiveBankruptcyKind,
  dossier: Readonly<BankruptcyDossier>
): void {
  if (kind === BankruptcyKind.HARD) {
    options.push(
      buildProposalOption(
        ProposalOptionKind.REQUEST_CONFIRMATION,
        true,
        dossier.dropped_candidates,
        dossier.unresolved_conflicts
      )
    );
  }

  if (params.triggerKind === BankruptcyTriggerKind.SAFETY_GUARD) {
    options.push(
      buildProposalOption(
        ProposalOptionKind.ABORT_HIGH_RISK_WRITE,
        true,
        [],
        dossier.unresolved_conflicts
      )
    );
  }
}

function ensureFallbackProposalOption(
  options: ProposalOption[],
  dossier: Readonly<BankruptcyDossier>
): void {
  if (options.length > 0) {
    return;
  }

  options.push(
    buildProposalOption(
      ProposalOptionKind.REQUEST_CONFIRMATION,
      true,
      dossier.dropped_candidates,
      dossier.unresolved_conflicts
    )
  );
}
