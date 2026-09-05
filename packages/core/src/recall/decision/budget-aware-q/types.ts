// C02 prototype types. C05 may reuse this module; C08 deletes it if unused.
// Not wired to executeRecall / deliverCanonicalFineAssessment.

export const BUDGET_AWARE_Q_AUTHORITY = "budget_aware_q" as const;

export const C02_POLICY = Object.freeze({
  kDefault: 5,
  requestBudget: 2000,
  envelopeBytes: 64,
  tokensPerUtf8Byte: 1,
  nBase: 64,
  nExtension: 64,
  rBase: 512,
  rExtension: 512,
  packetM: 64,
  widthW: 4,
  joinWidth: 2
});

export function decisionWorkLimit(k: number, packetM: number): number {
  return 2 * k * packetM;
}

export type RetrievalFamily = "lexical" | "typed_relation" | "embedding";

export const BASELINE_FAMILIES: readonly RetrievalFamily[] = Object.freeze([
  "lexical",
  "typed_relation"
]);

export const EXTENSION_FAMILIES: readonly RetrievalFamily[] = Object.freeze([
  "embedding"
]);

export const FAMILY_ORDER: readonly RetrievalFamily[] = Object.freeze([
  ...BASELINE_FAMILIES,
  ...EXTENSION_FAMILIES
]);

export type CapabilityState = "ready" | "unavailable" | "pending" | "not_requested";

export interface FamilyHit {
  readonly id: string;
  readonly rank: number;
}

export interface FamilyProbeResult {
  readonly family: RetrievalFamily;
  readonly probeId: string;
  readonly hits: readonly FamilyHit[];
}

export interface EvidenceUnit {
  readonly id: string;
  readonly content: string;
  readonly framedBytes: number;
  readonly chargedTokens: number;
  readonly familyRanks: Readonly<Partial<Record<RetrievalFamily, number>>>;
  readonly answerBindings: readonly string[];
  readonly assignmentKey: string | null;
}

export interface TypedSupportEdge {
  readonly predicate: string;
  readonly assignmentKey: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly resultObjectId: string;
}

export interface PacketProposal {
  readonly id: string;
  readonly unitIds: readonly string[];
}

export interface GroundedObligation {
  readonly kind: string;
  readonly bindingSlot: string;
  readonly assignmentKey: string;
  readonly requiredPredicates: readonly string[];
}

export interface QuerySpec {
  readonly text: string;
  readonly principal: string;
  readonly workspaceId: string;
  readonly authorizedScopes: readonly string[];
  readonly asOf: string;
  readonly k: number;
  readonly tokenBudget: number;
  readonly nBase: number;
  readonly nExtension: number;
  readonly rBase: number;
  readonly rExtension: number;
  readonly packetM: number;
  readonly widthW: number;
  readonly workLimit: number;
  readonly envelopeBytes: number;
  readonly enumeration: boolean;
  readonly exactAggregate: boolean;
  readonly diagnostics: boolean;
  readonly deliveryPath: string | null;
  readonly obligations: readonly GroundedObligation[];
  readonly familyCaps: Readonly<Record<RetrievalFamily, CapabilityState>>;
}

export interface QuerySpecDraft {
  readonly text: string;
  readonly principal?: string;
  readonly workspaceId?: string;
  readonly authorizedScopes?: readonly string[];
  readonly asOf?: string;
  readonly k?: number;
  readonly tokenBudget?: number;
  readonly nBase?: number;
  readonly nExtension?: number;
  readonly rBase?: number;
  readonly rExtension?: number;
  readonly packetM?: number;
  readonly widthW?: number;
  readonly workLimit?: number;
  readonly envelopeBytes?: number;
  readonly enumeration?: boolean;
  readonly exactAggregate?: boolean;
  readonly diagnostics?: boolean;
  readonly deliveryPath?: string | null;
  readonly obligations?: readonly GroundedObligation[];
  readonly familyCaps?: Readonly<Partial<Record<RetrievalFamily, CapabilityState>>>;
}

export type ClaimDisposition =
  | { readonly kind: "heuristic_evidence" }
  | { readonly kind: "observed_scoped_relation" }
  | { readonly kind: "joint_support" }
  | { readonly kind: "valid_time" }
  | { readonly kind: "enumeration_observed_not_all" }
  | { readonly kind: "unsupported_exact_aggregate" }
  | { readonly kind: "capability_unavailable"; readonly capability: string }
  | { readonly kind: "obligation_unsatisfied" }
  | { readonly kind: "truncated" }
  | { readonly kind: "conflict_distinct_lineages" }
  | { readonly kind: "unsupported_mode"; readonly mode: string };

export interface AdmittedField {
  readonly e0: readonly string[];
  readonly e1: readonly string[];
  readonly ranks: Readonly<Map<string, Readonly<Partial<Record<RetrievalFamily, number>>>>>;
  readonly rowVisits: number;
  readonly truncated: boolean;
}

export interface DecisionResult {
  readonly ranking_authority: typeof BUDGET_AWARE_Q_AUTHORITY;
  readonly membership: readonly string[];
  readonly order: readonly string[];
  readonly chargedTokens: number;
  readonly actualBytes: number;
  readonly claims: readonly ClaimDisposition[];
  readonly truncated: boolean;
  readonly selectionCount: number;
  readonly querySpecDigest: string;
  readonly satisfiedObligations: number;
  readonly bindingCount: number;
  readonly usedPacketIds: readonly string[];
}

export interface PackedRecall {
  readonly ranking_authority: typeof BUDGET_AWARE_Q_AUTHORITY;
  readonly results: readonly Readonly<{ readonly object_id: string; readonly content: string }>[];
  readonly claims: readonly ClaimDisposition[];
  readonly truncated: boolean;
}

export function frameEntry(id: string, content: string): string {
  return `${id}\n${content}\n`;
}

export function framedByteLength(id: string, content: string): number {
  return Buffer.byteLength(frameEntry(id, content), "utf8");
}

export function compareIdentity(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareIdentitySequence(
  left: readonly string[],
  right: readonly string[]
): number {
  const bound = Math.min(left.length, right.length);
  for (let index = 0; index < bound; index += 1) {
    const delta = compareIdentity(left[index]!, right[index]!);
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}
