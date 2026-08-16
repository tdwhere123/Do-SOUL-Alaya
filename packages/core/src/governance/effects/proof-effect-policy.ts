import {
  EffectRequestSchema,
  PROOF_EFFECT_OPERATOR_ID,
  hashEffectRequestDigest,
  type EffectDecision,
  type EffectDecisionReceipt,
  type EffectRequest,
  type FieldContractSha256,
  type ProofEffectPort
} from "@do-soul/alaya-protocol";
import { readNow, type NowProvider } from "../../shared/time.js";
import { defaultFieldSha256 } from "./field-hash.js";
import { isHardActive, type DualTimeFields } from "./dual-time.js";

export const GovernedEffectAction = {
  CORRECT: "correct",
  SUPERSEDE: "supersede",
  REVOKE: "revoke",
  SEAL: "seal",
  ERASE: "erase",
  ACTIVATE: "activate",
  RESTORE: "restore"
} as const;

export type GovernedEffectAction =
  typeof GovernedEffectAction[keyof typeof GovernedEffectAction];

export type ProofKind =
  | "source_grounding"
  | "lineage"
  | "scope_adoption"
  | "actor_authority"
  | "confirmation"
  | "predecessor"
  | "successor"
  | "soft_strength"
  | "similarity"
  | "embedding"
  | "relevance";

export type ProofRecord = Readonly<{
  readonly id: string;
  readonly kind: ProofKind;
  readonly workspace_id: string;
  readonly target?: string;
  readonly scope?: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly event_time: string | null;
  readonly recorded_at: string;
  readonly revoked?: boolean;
}>;

export type CompetingClaim = DualTimeFields & Readonly<{
  readonly id: string;
  readonly has_evidence: boolean;
  readonly scope_compatible: boolean;
}>;

export interface ProofEffectLookup {
  findReceipts(ids: readonly string[]): readonly ProofRecord[];
  isBridgeRevoked(scope: string, asOf: string): boolean;
  competingClaims(target: string, scope: string): readonly CompetingClaim[];
  isErased(target: string): boolean;
  readTargetTime?(target: string): DualTimeFields | null;
}

export interface ProofCarryingEffectOwnerDependencies {
  readonly lookup: ProofEffectLookup;
  readonly now?: NowProvider;
  readonly sha256?: FieldContractSha256;
}

const SOFT_PROOF_KINDS = new Set<ProofKind>([
  "soft_strength",
  "similarity",
  "embedding",
  "relevance"
]);

const HARD_ACTIONS = new Set<string>([
  GovernedEffectAction.CORRECT,
  GovernedEffectAction.SUPERSEDE,
  GovernedEffectAction.REVOKE,
  GovernedEffectAction.SEAL,
  GovernedEffectAction.ERASE,
  GovernedEffectAction.ACTIVATE
]);

export class ProofCarryingEffectOwner implements ProofEffectPort {
  private readonly lookup: ProofEffectLookup;
  private readonly now: NowProvider;
  private readonly sha256: FieldContractSha256;

  public constructor(dependencies: ProofCarryingEffectOwnerDependencies) {
    this.lookup = dependencies.lookup;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.sha256 = dependencies.sha256 ?? defaultFieldSha256;
  }

  public decide(input: EffectRequest): EffectDecisionReceipt {
    const request = EffectRequestSchema.parse(input);
    return buildEffectDecisionReceipt(
      request,
      this.classify(request, this.collectFacts(request)),
      readNow(this.now),
      this.sha256
    );
  }

  private collectFacts(request: EffectRequest): ProofFacts {
    const receipts = this.lookup.findReceipts(request.supporting_receipt_ids);
    return {
      receipts,
      missingIds: missingReceiptIds(request.supporting_receipt_ids, receipts),
      authorizing: receipts.filter((receipt) => !SOFT_PROOF_KINDS.has(receipt.kind)),
      kinds: new Set(receipts.map((receipt) => receipt.kind)),
      targetTime: this.lookup.readTargetTime?.(request.target) ?? null,
      bridgeRevoked: this.lookup.isBridgeRevoked(request.scope, request.effective_as_of),
      erased: this.lookup.isErased(request.target),
      competing: this.lookup.competingClaims(request.target, request.scope)
    };
  }

  private classify(request: EffectRequest, facts: ProofFacts): EffectDecision {
    if (!HARD_ACTIONS.has(request.action) && request.action !== GovernedEffectAction.RESTORE) {
      return "deny";
    }
    if (request.action === GovernedEffectAction.RESTORE) return "deny";
    if (facts.erased && request.action !== GovernedEffectAction.ERASE) return "deny";
    if (facts.bridgeRevoked) return "deny";
    if (facts.missingIds.length > 0 || facts.authorizing.length === 0) return "deny";
    if (hasHardDispute(facts.competing, request.effective_as_of)) return "defer";
    return classifyAction(request, facts);
  }
}

type ProofFacts = Readonly<{
  readonly receipts: readonly ProofRecord[];
  readonly missingIds: readonly string[];
  readonly authorizing: readonly ProofRecord[];
  readonly kinds: ReadonlySet<ProofKind>;
  readonly targetTime: DualTimeFields | null;
  readonly bridgeRevoked: boolean;
  readonly erased: boolean;
  readonly competing: readonly CompetingClaim[];
}>;

function classifyAction(request: EffectRequest, facts: ProofFacts): EffectDecision {
  if (request.action === GovernedEffectAction.ACTIVATE) {
    return facts.targetTime !== null && isHardActive(facts.targetTime, request.effective_as_of)
      && facts.kinds.has("source_grounding")
      ? "allow"
      : "deny";
  }
  if (request.action === GovernedEffectAction.CORRECT || request.action === GovernedEffectAction.SUPERSEDE) {
    return classifySuccessorAction(request, facts);
  }
  if (request.action === GovernedEffectAction.REVOKE) {
    return facts.kinds.has("actor_authority") ? "allow" : "deny";
  }
  if (request.action === GovernedEffectAction.SEAL || request.action === GovernedEffectAction.ERASE) {
    if (!facts.kinds.has("actor_authority")) return "deny";
    return facts.kinds.has("confirmation") ? "allow" : "require_confirmation";
  }
  return "deny";
}

function classifySuccessorAction(request: EffectRequest, facts: ProofFacts): EffectDecision {
  if (!facts.kinds.has("predecessor") || !facts.kinds.has("successor")) return "deny";
  if (!facts.kinds.has("source_grounding") && !facts.kinds.has("lineage")) return "deny";
  if (facts.targetTime !== null && facts.targetTime.valid_from === null) return "defer";
  if (hasPossibleConflict(facts.competing)) return "defer";
  return request.effective_as_of.length > 0 ? "allow" : "deny";
}

function missingReceiptIds(
  requested: readonly string[],
  found: readonly ProofRecord[]
): readonly string[] {
  const present = new Set(found.map((receipt) => receipt.id));
  return requested.filter((id) => !present.has(id));
}

function hasHardDispute(claims: readonly CompetingClaim[], asOf: string): boolean {
  const evidenced = claims.filter((claim) => claim.has_evidence && claim.scope_compatible);
  if (evidenced.length < 2) return false;
  return evidenced.some((left, index) =>
    evidenced.slice(index + 1).some((right) => validityOverlaps(left, right, asOf))
  );
}

function hasPossibleConflict(claims: readonly CompetingClaim[]): boolean {
  return claims.some((claim) => claim.valid_from === null);
}

function validityOverlaps(left: CompetingClaim, right: CompetingClaim, asOf: string): boolean {
  if (left.valid_from === null || right.valid_from === null) return false;
  const leftEnd = left.valid_to ?? asOf;
  const rightEnd = right.valid_to ?? asOf;
  return left.valid_from < rightEnd && right.valid_from < leftEnd;
}

export function buildEffectDecisionReceipt(
  request: EffectRequest,
  decision: EffectDecision,
  recordedAt: string,
  sha256: FieldContractSha256
): EffectDecisionReceipt {
  const digest = hashEffectRequestDigest(request, sha256);
  return Object.freeze({
    schema_version: 1,
    producer: PROOF_EFFECT_OPERATOR_ID,
    consumer: "governance",
    identity: digest,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "policy_decision",
    deletion_behavior: "retain_identity",
    workspace_id: request.workspace_id,
    request_digest: digest,
    action: request.action,
    target: request.target,
    scope: request.scope,
    effective_as_of: request.effective_as_of,
    decision,
    supporting_receipt_ids: request.supporting_receipt_ids,
    recorded_at: recordedAt
  });
}
