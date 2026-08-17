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
import { fieldContractSha256 } from "../../shared/field-hash.js";
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
  | "governance_snapshot"
  | "soft_strength"
  | "similarity"
  | "embedding"
  | "relevance";

type ProofRecordBase = Readonly<{
  readonly id: string;
  readonly workspace_id: string;
  readonly recorded_at: string;
  readonly revoked?: boolean;
}>;

type ProofTargetBinding = Readonly<{
  readonly target: string;
  readonly scope: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly event_time: string | null;
}>;

type SoftProofKind = "soft_strength" | "similarity" | "embedding" | "relevance";
type AuthorizingProofKind = Exclude<ProofKind, SoftProofKind | "actor_authority">;

export type ProofRecord =
  | (ProofRecordBase & ProofTargetBinding & Readonly<{
      readonly kind: "actor_authority";
      readonly actor_id: string;
      readonly run_id: string;
      readonly delivery_id: string;
    }>)
  | (ProofRecordBase & ProofTargetBinding & Readonly<{
      readonly kind: AuthorizingProofKind;
    }>)
  | (ProofRecordBase & Readonly<{
      readonly kind: SoftProofKind;
    }>);

type AuthorizingProofRecord = Exclude<ProofRecord, { readonly kind: SoftProofKind }>;

export type CompetingClaim = DualTimeFields & Readonly<{
  readonly id: string;
  readonly has_evidence: boolean;
  readonly scope_compatible: boolean;
}>;

export interface ProofEffectLookup {
  findReceipts(workspaceId: string, ids: readonly string[]): readonly ProofRecord[];
  isBridgeRevoked(workspaceId: string, scope: string, asOf: string): boolean;
  competingClaims(workspaceId: string, target: string, scope: string): readonly CompetingClaim[];
  isErased(workspaceId: string, target: string): boolean;
  readTargetTime?(workspaceId: string, target: string): DualTimeFields | null;
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
    this.sha256 = dependencies.sha256 ?? fieldContractSha256;
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
    const receipts = this.lookup.findReceipts(
      request.workspace_id,
      request.supporting_receipt_ids
    );
    const authorizing = receipts.filter(isAuthorizingProof);
    return {
      receipts,
      missingIds: missingReceiptIds(request.supporting_receipt_ids, receipts),
      authorizing,
      invalidAuthorizing: authorizing.filter((receipt) =>
        !isProofApplicable(receipt, request)
      ),
      kinds: new Set(receipts.map((receipt) => receipt.kind)),
      targetTime: this.lookup.readTargetTime?.(request.workspace_id, request.target) ?? null,
      bridgeRevoked: this.lookup.isBridgeRevoked(
        request.workspace_id,
        request.scope,
        request.effective_as_of
      ),
      erased: this.lookup.isErased(request.workspace_id, request.target),
      competing: this.lookup.competingClaims(
        request.workspace_id,
        request.target,
        request.scope
      )
    };
  }

  private classify(request: EffectRequest, facts: ProofFacts): EffectDecision {
    if (!HARD_ACTIONS.has(request.action) && request.action !== GovernedEffectAction.RESTORE) {
      return "deny";
    }
    if (request.action === GovernedEffectAction.RESTORE) return "deny";
    if (facts.erased && request.action !== GovernedEffectAction.ERASE) return "deny";
    if (facts.bridgeRevoked) return "deny";
    if (facts.missingIds.length > 0 || facts.authorizing.length === 0 ||
        facts.invalidAuthorizing.length > 0) return "deny";
    if (!facts.kinds.has("actor_authority")) return "deny";
    if (hasHardDispute(facts.competing, request.effective_as_of)) return "defer";
    return classifyAction(request, facts);
  }
}

type ProofFacts = Readonly<{
  readonly receipts: readonly ProofRecord[];
  readonly missingIds: readonly string[];
  readonly authorizing: readonly AuthorizingProofRecord[];
  readonly invalidAuthorizing: readonly AuthorizingProofRecord[];
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
  if (facts.targetTime === null || facts.targetTime.valid_from === null) return "defer";
  if (hasPossibleConflict(facts.competing)) return "defer";
  return request.effective_as_of.length > 0 ? "allow" : "deny";
}

function isAuthorizingProof(receipt: ProofRecord): receipt is AuthorizingProofRecord {
  return !SOFT_PROOF_KINDS.has(receipt.kind);
}

function isProofApplicable(receipt: AuthorizingProofRecord, request: EffectRequest): boolean {
  if (receipt.revoked === true || receipt.workspace_id !== request.workspace_id) return false;
  if (receipt.target !== request.target || receipt.scope !== request.scope) return false;
  if (receipt.kind === "actor_authority" && (
    receipt.actor_id !== request.actor_id ||
    receipt.run_id !== request.run_id ||
    receipt.delivery_id !== request.delivery_id
  )) return false;
  if (receipt.event_time === null || receipt.valid_from === null) return false;
  const asOfMs = Date.parse(request.effective_as_of);
  const eventMs = Date.parse(receipt.event_time);
  const validFromMs = Date.parse(receipt.valid_from);
  const validToMs = receipt.valid_to === null ? Number.POSITIVE_INFINITY : Date.parse(receipt.valid_to);
  const recordedMs = Date.parse(receipt.recorded_at);
  return Number.isFinite(asOfMs) && Number.isFinite(eventMs) &&
    Number.isFinite(validFromMs) && Number.isFinite(recordedMs) &&
    recordedMs <= asOfMs &&
    eventMs <= asOfMs && validFromMs <= asOfMs && asOfMs < validToMs;
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
    schema_version: 2,
    producer: PROOF_EFFECT_OPERATOR_ID,
    consumer: "governance",
    identity: digest,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "policy_decision",
    deletion_behavior: "retain_identity",
    workspace_id: request.workspace_id,
    actor_id: request.actor_id,
    run_id: request.run_id,
    delivery_id: request.delivery_id,
    request_digest: digest,
    action: request.action,
    target: request.target,
    scope: request.scope,
    effective_as_of: request.effective_as_of,
    decision,
    supporting_receipt_ids: request.supporting_receipt_ids,
    supporting_proof_witnesses: request.supporting_proof_witnesses,
    governance_frontier: request.governance_frontier,
    policy_operator_id: request.policy_operator_id,
    policy_operator_version: request.policy_operator_version,
    recorded_at: recordedAt
  });
}
