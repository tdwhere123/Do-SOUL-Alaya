import {
  assertAllowedKeys,
  assertShadowReceiptHasNoDeliveryOrder,
  freezeShadow,
  isShadowRecord,
  ShadowContractError
} from "../contract-primitives.js";
import {
  SHADOW_PAIR_REASONS,
  type ShadowPairReason
} from "./compare.js";

export const SHADOW_PSI_OPERATOR_ID = "shadow.psi.safe_dominance.v1";

export type ShadowPsiEdge = Readonly<{
  readonly kind: "psi_edge";
  readonly operator_id: typeof SHADOW_PSI_OPERATOR_ID;
  readonly dominator: string;
  readonly dominated: string;
}>;

export type ShadowPsiPairReceipt = Readonly<{
  readonly left: string;
  readonly right: string;
  readonly reason: ShadowPairReason;
  readonly dominates: boolean;
}>;

export type ShadowNotADominanceCompare = Readonly<{
  readonly kind: "not_a_dominance_compare";
  readonly reason: "h_ineligible";
  readonly gate: "event" | "temporal" | "hidden";
  readonly candidate_key: string;
}>;

export type ShadowAdmitKind =
  | "fts.admit.v1"
  | "embed.admit.v1"
  | "temporal.admit.v1"
  | "graph.admit.v1"
  | "path.admit.v1";

export type ShadowEmbeddingAdmissionProvenance = Readonly<{
  readonly receipt: "embed.admit.v1";
  readonly membership_only: true;
  readonly cannot_evict_e0: true;
}>;

export type ShadowFieldMembership = Readonly<{
  readonly candidate_key: string;
  readonly e0_member: boolean;
  readonly e1_member: boolean;
  readonly admits: readonly ShadowAdmitKind[];
  readonly embedding_admission: ShadowEmbeddingAdmissionProvenance | null;
}>;

export type ShadowUnsupportedRelationalSource =
  | "path"
  | "flood"
  | "graph"
  | "edge"
  | "path_status"
  | "flood_trace"
  | "no_path_under_cap"
  | "truncation"
  | "cap_exhaustion"
  | "not_observed"
  | "producer_unavailable";

export type ShadowUnsupportedRelationalDiagnostic = Readonly<{
  readonly kind: "unsupported_relational_diagnostic";
  readonly source: ShadowUnsupportedRelationalSource;
  readonly facts: Readonly<Record<string, unknown>>;
}>;

const PAIR_REASON_SET: ReadonlySet<string> = new Set(SHADOW_PAIR_REASONS);
const ADMIT_KINDS: ReadonlySet<string> = new Set([
  "fts.admit.v1",
  "embed.admit.v1",
  "temporal.admit.v1",
  "graph.admit.v1",
  "path.admit.v1"
]);
const RELATIONAL_SOURCES: ReadonlySet<string> = new Set([
  "path",
  "flood",
  "graph",
  "edge",
  "path_status",
  "flood_trace",
  "no_path_under_cap",
  "truncation",
  "cap_exhaustion",
  "not_observed",
  "producer_unavailable"
]);

export function parsePsiEdge(input: unknown): ShadowPsiEdge {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("psi edge must be an object");
  }
  assertShadowReceiptHasNoDeliveryOrder(input);
  assertAllowedKeys(input, ["kind", "operator_id", "dominator", "dominated"]);
  if (input.kind !== "psi_edge" || input.operator_id !== SHADOW_PSI_OPERATOR_ID ||
      typeof input.dominator !== "string" || typeof input.dominated !== "string" ||
      input.dominator.length === 0 || input.dominated.length === 0) {
    throw new ShadowContractError("invalid psi edge");
  }
  if (input.dominator === input.dominated) {
    throw new ShadowContractError("psi edge is irreflexive");
  }
  return freezeShadow({
    kind: "psi_edge",
    operator_id: SHADOW_PSI_OPERATOR_ID,
    dominator: input.dominator,
    dominated: input.dominated
  });
}

export function parsePsiPairReceipt(input: unknown): ShadowPsiPairReceipt {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("psi pair receipt must be an object");
  }
  assertAllowedKeys(input, ["left", "right", "reason", "dominates"]);
  if (typeof input.left !== "string" || typeof input.right !== "string" ||
      typeof input.reason !== "string" || !PAIR_REASON_SET.has(input.reason) ||
      input.dominates !== false) {
    throw new ShadowContractError("invalid psi pair receipt");
  }
  return freezeShadow({
    left: input.left,
    right: input.right,
    reason: input.reason as ShadowPairReason,
    dominates: false
  });
}

export function parseFieldMembership(input: unknown): ShadowFieldMembership {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("field membership must be an object");
  }
  assertAllowedKeys(input, [
    "candidate_key", "e0_member", "e1_member", "admits", "embedding_admission"
  ]);
  if (typeof input.candidate_key !== "string" || input.candidate_key.length === 0 ||
      typeof input.e0_member !== "boolean" || typeof input.e1_member !== "boolean" ||
      !Array.isArray(input.admits)) {
    throw new ShadowContractError("invalid field membership");
  }
  if (input.e0_member && !input.e1_member) {
    throw new ShadowContractError("H_E0 must be a subset of H_E1");
  }
  const admits = Object.freeze(input.admits.map(parseAdmitKind));
  const embeddingAdmission = parseEmbeddingAdmission(
    input.embedding_admission,
    admits,
    input.e1_member
  );
  return freezeShadow({
    candidate_key: input.candidate_key,
    e0_member: input.e0_member,
    e1_member: input.e1_member,
    admits,
    embedding_admission: embeddingAdmission
  });
}

export function parseUnsupportedRelationalDiagnostic(
  input: unknown
): ShadowUnsupportedRelationalDiagnostic {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("unsupported diagnostic must be an object");
  }
  assertAllowedKeys(input, ["kind", "source", "facts"]);
  if (input.kind !== "unsupported_relational_diagnostic" ||
      typeof input.source !== "string" || !RELATIONAL_SOURCES.has(input.source) ||
      !isShadowRecord(input.facts)) {
    throw new ShadowContractError("invalid unsupported relational diagnostic");
  }
  return freezeShadow({
    kind: "unsupported_relational_diagnostic",
    source: input.source as ShadowUnsupportedRelationalSource,
    facts: freezeShadow({ ...input.facts })
  });
}

export function observationFromUnsupportedDiagnostic(
  _diagnostic: ShadowUnsupportedRelationalDiagnostic
): never {
  throw new ShadowContractError("Path/Flood facts cannot instantiate v1 observation");
}

export function rejectNegativeRelationalEvidence(
  diagnostic: ShadowUnsupportedRelationalDiagnostic
): never {
  throw new ShadowContractError(
    `${diagnostic.source} cannot validate as negative relational evidence`
  );
}

function parseAdmitKind(value: unknown): ShadowAdmitKind {
  if (typeof value !== "string" || !ADMIT_KINDS.has(value)) {
    throw new ShadowContractError("invalid membership admit receipt");
  }
  return value as ShadowAdmitKind;
}

function parseEmbeddingAdmission(
  input: unknown,
  admits: readonly ShadowAdmitKind[],
  e1Member: boolean
): ShadowEmbeddingAdmissionProvenance | null {
  if (input === null) {
    if (admits.includes("embed.admit.v1")) {
      throw new ShadowContractError("embed.admit.v1 needs provenance");
    }
    return null;
  }
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("embedding admission must be an object");
  }
  assertAllowedKeys(input, ["receipt", "membership_only", "cannot_evict_e0"]);
  if (input.receipt !== "embed.admit.v1" || input.membership_only !== true ||
      input.cannot_evict_e0 !== true || !e1Member ||
      !admits.includes("embed.admit.v1")) {
    throw new ShadowContractError("invalid embedding-admission provenance");
  }
  return freezeShadow({
    receipt: "embed.admit.v1",
    membership_only: true,
    cannot_evict_e0: true
  });
}
