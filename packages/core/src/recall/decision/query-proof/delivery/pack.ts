import { types as nodeTypes } from "node:util";
import { compareText } from "../../../../shared/compare-text.js";
import { ShadowContractError } from "../../contract-primitives.js";
import type { RecallFieldDigest } from "../../../field/field-identity.js";
import {
  deriveAllowedClaims,
  digestDeliveryPackBody,
  hasHoleImpact,
  isCompletenessScope,
  NON_INTERFERING_PRINCIPAL_SCOPE,
  QUERY_PROOF_DELIVERY_PACK_OPERATOR_ID,
  SEAL_UNBOUND_HOLE,
  unavailableDeliveryDigest,
  type DeliveryAllowedClaimV1,
  type DeliveryAnswerKindV1,
  type DeliveryCompletenessScopeV1,
  type DeliveryPackBindingV1,
  type DeliveryPackConflictV1,
  type DeliveryPackEvidenceGroupV1,
  type DeliveryPackHoleV1,
  type DeliveryPackInputV1,
  type DeliveryPackModeV1,
  type DeliveryPackPropositionV1,
  type DeliveryPackV1,
  type DeliveryPrincipalScopeV1
} from "./contract.js";

const PACK_MODES = new Set<DeliveryPackModeV1>([
  "certified", "best_effort_uncertified", "abstained", "unsupported", "conflict"
]);
const ANSWER_KINDS = new Set<DeliveryAnswerKindV1>([
  "scalar", "extremum", "all_observable", "none"
]);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export type ShadowDeliveryPackBindV1 = Readonly<{
  readonly selected_candidates: readonly string[];
  readonly capture_identity_digest: string;
  readonly preview_status?: "captured" | "failed";
  readonly preview_bindings?: readonly DeliveryPackBindingV1[];
  readonly preview_contract_digest?: string;
  readonly snapshot_digest?: string;
}>;

export function buildDeliveryPack(input: DeliveryPackInputV1): DeliveryPackV1 {
  const captured = capturePackPremises(input);
  assertPackLegal(captured);
  return sealPack(captured);
}

export function buildShadowDeliveryPack(bind: ShadowDeliveryPackBindV1): DeliveryPackV1 {
  const captured = capturePackPremises(bind);
  const input = shadowInputFrom(captured);
  assertPackLegal(input);
  return sealPack(input);
}

export function parseDeliveryPack(value: unknown): DeliveryPackV1 {
  return finishParse(capturePackPremises(requirePackRecord(value)));
}

export function parseCertifiedDeliveryPack(value: unknown): DeliveryPackV1 {
  const record = capturePackPremises(requirePackRecord(value));
  if (record.mode !== "certified") {
    throw new ShadowContractError("best-effort or non-certified pack cannot parse as certified");
  }
  return finishParse(record);
}

function finishParse(record: Partial<DeliveryPackV1>): DeliveryPackV1 {
  if (typeof record.pack_digest !== "string" || record.pack_digest.length === 0) {
    throw new ShadowContractError("delivery pack digest is required");
  }
  const built = buildDeliveryPack(packValueAsInput(record));
  if (record.allowed_claims !== undefined
    && !sameClaims(record.allowed_claims, built.allowed_claims)) {
    throw new ShadowContractError("delivery pack allowed claims do not match the mode contract");
  }
  if (record.pack_digest !== built.pack_digest) {
    throw new ShadowContractError("delivery pack digest mismatch");
  }
  if (record.utilization !== undefined && record.utilization !== "delivered_not_used") {
    throw new ShadowContractError("delivery pack cannot record utilization as used");
  }
  return built;
}

function shadowInputFrom(bind: ShadowDeliveryPackBindV1): DeliveryPackInputV1 {
  const abstained = bind.preview_status !== "captured";
  return {
    mode: abstained ? "abstained" : "best_effort_uncertified",
    query_digest: unavailableDeliveryDigest("query_digest"),
    snapshot_digest: boundDigestOrUnavailable(bind.snapshot_digest, "snapshot_digest"),
    decision_contract_digest: boundDigestOrUnavailable(
      bind.preview_contract_digest, "decision_contract_digest"
    ),
    capture_identity_digest: bind.capture_identity_digest,
    selected_candidates: bind.selected_candidates,
    answer_kind: "none",
    answer_bindings: bind.preview_bindings ?? [],
    propositions: [],
    evidence_groups: [],
    holes: [SEAL_UNBOUND_HOLE],
    conflicts: [],
    completeness_scope: null,
    principal_scope: NON_INTERFERING_PRINCIPAL_SCOPE
  };
}

function sealPack(input: DeliveryPackInputV1): DeliveryPackV1 {
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: QUERY_PROOF_DELIVERY_PACK_OPERATOR_ID,
    mode: input.mode,
    query_digest: input.query_digest,
    snapshot_digest: input.snapshot_digest,
    decision_contract_digest: input.decision_contract_digest,
    capture_identity_digest: input.capture_identity_digest,
    selected_candidates: Object.freeze([...input.selected_candidates]),
    answer_kind: input.answer_kind,
    answer_bindings: Object.freeze(input.answer_bindings.map(freezeBinding)),
    propositions: Object.freeze(input.propositions.map(freezeProposition)),
    evidence_groups: Object.freeze(input.evidence_groups.map(freezeGroup)),
    holes: Object.freeze(input.holes.map(freezeHole)),
    conflicts: Object.freeze(input.conflicts.map(freezeConflict)),
    completeness_scope: freezeScope(input.completeness_scope),
    principal_scope: freezePrincipal(input.principal_scope),
    allowed_claims: deriveAllowedClaims(input),
    utilization: "delivered_not_used" as const,
    prefix_authority: "prefix_sk" as const
  });
  return Object.freeze({ ...body, pack_digest: digestDeliveryPackBody(body) });
}

function assertPackLegal(input: DeliveryPackInputV1): void {
  if (!PACK_MODES.has(input.mode)) {
    throw new ShadowContractError("delivery pack mode is unsupported");
  }
  if (!ANSWER_KINDS.has(input.answer_kind)) {
    throw new ShadowContractError("delivery pack answer kind is unsupported");
  }
  if (input.capture_identity_digest.length === 0) {
    throw new ShadowContractError("delivery pack requires capture identity");
  }
  if (input.principal_scope.delivery_interference !== false) {
    throw new ShadowContractError("principal scope must not interfere with delivery");
  }
  if (input.mode === "conflict" && input.conflicts.length === 0) {
    throw new ShadowContractError("conflict pack requires conflict records");
  }
  if (input.mode !== "certified"
    && !hasHoleImpact(input.holes, "blocks_certified_delivery")) {
    throw new ShadowContractError("non-certified pack requires a certified-delivery hole");
  }
  if (input.mode === "certified") {
    if (input.conflicts.length > 0) {
      throw new ShadowContractError("certified pack cannot carry unresolved conflicts");
    }
    if (hasHoleImpact(input.holes, "blocks_certified_delivery")
      || hasHoleImpact(input.holes, "blocks_all_delivery")) {
      throw new ShadowContractError("certified pack cannot carry blocking holes");
    }
    if (isUnavailableDigest(input.query_digest, "query_digest")
      || isUnavailableDigest(input.snapshot_digest, "snapshot_digest")
      || isUnavailableDigest(input.decision_contract_digest, "decision_contract_digest")) {
      throw new ShadowContractError("certified pack cannot use unavailable digests");
    }
  }
}

function requirePackRecord(value: unknown): Partial<DeliveryPackV1> {
  if (typeof value !== "object" || value === null) {
    throw new ShadowContractError("delivery pack must be an object");
  }
  return value as Partial<DeliveryPackV1>;
}

function packValueAsInput(record: Partial<DeliveryPackV1>): DeliveryPackInputV1 {
  if (record.operator_id !== QUERY_PROOF_DELIVERY_PACK_OPERATOR_ID) {
    throw new ShadowContractError("delivery pack operator identity mismatch");
  }
  if (record.schema_version !== 1) {
    throw new ShadowContractError("delivery pack schema is unsupported");
  }
  if (record.prefix_authority !== undefined && record.prefix_authority !== "prefix_sk") {
    throw new ShadowContractError("delivery pack cannot select a non-prefix_sk order");
  }
  return {
    mode: requireMode(record.mode),
    query_digest: requireDigest(record.query_digest, "query_digest"),
    snapshot_digest: requireDigest(record.snapshot_digest, "snapshot_digest"),
    decision_contract_digest: requireDigest(
      record.decision_contract_digest, "decision_contract_digest"
    ),
    capture_identity_digest: requireToken(record.capture_identity_digest, "capture identity"),
    selected_candidates: requireStringList(record.selected_candidates, "selected candidates"),
    answer_kind: requireAnswerKind(record.answer_kind),
    answer_bindings: requireArray(record.answer_bindings, "answer bindings"),
    propositions: requireArray(record.propositions, "propositions"),
    evidence_groups: requireArray(record.evidence_groups, "evidence groups"),
    holes: requireArray(record.holes, "holes"),
    conflicts: requireArray(record.conflicts, "conflicts"),
    completeness_scope: isCompletenessScope(record.completeness_scope)
      ? record.completeness_scope
      : null,
    principal_scope: record.principal_scope ?? NON_INTERFERING_PRINCIPAL_SCOPE
  };
}

function capturePackPremises<T>(value: T): T {
  return copyPlain(value) as T;
}

function copyPlain(value: unknown, ancestors: WeakSet<object> = new WeakSet()): unknown {
  if (value === undefined || value === null || typeof value === "string"
    || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ShadowContractError("delivery pack premises must be finite");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new ShadowContractError("delivery pack premises must be plain immutable data");
  }
  if (nodeTypes.isProxy(value)) {
    throw new ShadowContractError("delivery pack premises cannot use proxies");
  }
  if (ancestors.has(value)) {
    throw new ShadowContractError("delivery pack premises must be acyclic");
  }
  ancestors.add(value);
  try {
    return Array.isArray(value) ? copyArray(value, ancestors) : copyRecord(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function copyArray(
  value: readonly unknown[],
  ancestors: WeakSet<object>
): readonly unknown[] {
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new ShadowContractError("delivery pack arrays must be dense without extra fields");
  }
  const copied: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    copied.push(copyPlain(dataValue(value, index), ancestors));
  }
  return Object.freeze(copied);
}

function copyRecord(value: object, ancestors: WeakSet<object>): object {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ShadowContractError("delivery pack premises must be a plain record");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ShadowContractError("delivery pack premises must not contain symbol fields");
  }
  return Object.freeze(Object.fromEntries(Object.keys(value).sort(compareText).map((key) =>
    [key, copyPlain(dataValue(value, key), ancestors)])));
}

function dataValue(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new ShadowContractError("delivery pack premises cannot use getters");
  }
  return descriptor.value;
}

function isUnavailableDigest(value: RecallFieldDigest, field: string): boolean {
  return value === unavailableDeliveryDigest(field);
}

function boundDigestOrUnavailable(
  value: string | undefined,
  field: string
): RecallFieldDigest {
  if (value !== undefined && SHA256.test(value)) return value as RecallFieldDigest;
  return unavailableDeliveryDigest(field);
}

function sameClaims(
  left: readonly DeliveryAllowedClaimV1[],
  right: readonly DeliveryAllowedClaimV1[]
): boolean {
  return left.length === right.length
    && [...left].sort(compareText).every((claim, index) => claim === right[index]);
}

function requireMode(value: unknown): DeliveryPackModeV1 {
  if (typeof value !== "string" || !PACK_MODES.has(value as DeliveryPackModeV1)) {
    throw new ShadowContractError("delivery pack mode is unsupported");
  }
  return value as DeliveryPackModeV1;
}

function requireAnswerKind(value: unknown): DeliveryAnswerKindV1 {
  if (typeof value !== "string" || !ANSWER_KINDS.has(value as DeliveryAnswerKindV1)) {
    throw new ShadowContractError("delivery pack answer kind is unsupported");
  }
  return value as DeliveryAnswerKindV1;
}

function requireDigest(value: unknown, label: string): RecallFieldDigest {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ShadowContractError(`delivery pack ${label} is unavailable`);
  }
  return value as RecallFieldDigest;
}

function requireToken(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ShadowContractError(`delivery pack ${label} is required`);
  }
  return value;
}

function requireStringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ShadowContractError(`delivery pack ${label} must be a string list`);
  }
  return value;
}

function requireArray<T>(value: unknown, label: string): readonly T[] {
  if (!Array.isArray(value)) {
    throw new ShadowContractError(`delivery pack ${label} must be a list`);
  }
  return value as T[];
}

function freezeBinding(row: DeliveryPackBindingV1): DeliveryPackBindingV1 {
  return Object.freeze({ binding_id: row.binding_id, value: row.value });
}

function freezeProposition(row: DeliveryPackPropositionV1): DeliveryPackPropositionV1 {
  return Object.freeze({ proposition_id: row.proposition_id, support: row.support });
}

function freezeGroup(row: DeliveryPackEvidenceGroupV1): DeliveryPackEvidenceGroupV1 {
  return Object.freeze({
    group_id: row.group_id,
    member_keys: Object.freeze([...row.member_keys]),
    correlation: row.correlation
  });
}

function freezeHole(row: DeliveryPackHoleV1): DeliveryPackHoleV1 {
  return Object.freeze({
    provenance: row.provenance,
    code: row.code,
    impacts: Object.freeze([...row.impacts])
  });
}

function freezeConflict(row: DeliveryPackConflictV1): DeliveryPackConflictV1 {
  return Object.freeze({
    conflict_id: row.conflict_id,
    kind: row.kind,
    coordinate_ids: Object.freeze([...row.coordinate_ids])
  });
}

function freezeScope(
  scope: DeliveryCompletenessScopeV1 | null
): DeliveryCompletenessScopeV1 | null {
  if (!isCompletenessScope(scope)) return null;
  return Object.freeze({
    kind: "all_observable" as const,
    scope: scope.scope,
    principal: scope.principal,
    observer_contract: scope.observer_contract,
    snapshot_bind: "Sigma_q" as const
  });
}

function freezePrincipal(scope: DeliveryPrincipalScopeV1): DeliveryPrincipalScopeV1 {
  return Object.freeze({
    principal: scope.principal,
    effective_as_of: scope.effective_as_of,
    governance_frontier: scope.governance_frontier,
    delivery_interference: false as const
  });
}
