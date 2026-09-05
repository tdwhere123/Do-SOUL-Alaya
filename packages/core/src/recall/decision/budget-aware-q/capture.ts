import { hashConditionDigest, type FieldContractSha256 } from "@do-soul/alaya-protocol";
import {
  C02_POLICY,
  decisionWorkLimit,
  type CapabilityState,
  type QuerySpec,
  type QuerySpecDraft,
  type RetrievalFamily
} from "./types.js";

const DEFAULT_CAPS: Readonly<Record<RetrievalFamily, CapabilityState>> = Object.freeze({
  lexical: "ready",
  typed_relation: "not_requested",
  embedding: "not_requested"
});

export interface CapturedQuery {
  readonly spec: QuerySpec;
  readonly digest: string;
}

function copyStrings(values: readonly string[] | undefined, fallback: readonly string[]): readonly string[] {
  return Object.freeze(Array.from(values ?? fallback, (value) => String(value)));
}

function copyObligations(draft: QuerySpecDraft): QuerySpec["obligations"] {
  return Object.freeze((draft.obligations ?? []).map((obligation) => Object.freeze({
    kind: String(obligation.kind),
    bindingSlot: String(obligation.bindingSlot),
    assignmentKey: String(obligation.assignmentKey),
    requiredPredicates: Object.freeze(Array.from(obligation.requiredPredicates, (item) => String(item)))
  })));
}

function typedRelationDefault(draft: QuerySpecDraft): CapabilityState {
  if (draft.familyCaps?.typed_relation !== undefined) return draft.familyCaps.typed_relation;
  if ((draft.obligations ?? []).length > 0) return "ready";
  if (/\bown|\bowner|\bowned|\bescalation|\bchannel\b/iu.test(draft.text)) return "ready";
  return DEFAULT_CAPS.typed_relation;
}

function copyFamilyCaps(draft: QuerySpecDraft): QuerySpec["familyCaps"] {
  return Object.freeze({
    lexical: draft.familyCaps?.lexical ?? DEFAULT_CAPS.lexical,
    typed_relation: typedRelationDefault(draft),
    embedding: draft.familyCaps?.embedding ?? DEFAULT_CAPS.embedding
  });
}

function recognizeExactAggregate(text: string): boolean {
  return /\bhow many\b|\bcount of\b|\bsum of\b/iu.test(text);
}

function recognizeEnumeration(text: string): boolean {
  return /\blist\b|\bobserved\b/iu.test(text);
}

export function captureQuerySpec(
  draft: QuerySpecDraft,
  sha256: FieldContractSha256,
  now: () => string
): CapturedQuery {
  const text = String(draft.text);
  const k = draft.k ?? C02_POLICY.kDefault;
  const packetM = draft.packetM ?? C02_POLICY.packetM;
  const spec: QuerySpec = Object.freeze({
    text,
    principal: String(draft.principal ?? "agent"),
    workspaceId: String(draft.workspaceId ?? "workspace-1"),
    authorizedScopes: copyStrings(draft.authorizedScopes, [draft.workspaceId ?? "workspace-1"]),
    asOf: String(draft.asOf ?? now()),
    k,
    tokenBudget: draft.tokenBudget ?? C02_POLICY.requestBudget,
    nBase: draft.nBase ?? C02_POLICY.nBase,
    nExtension: draft.nExtension ?? C02_POLICY.nExtension,
    rBase: draft.rBase ?? C02_POLICY.rBase,
    rExtension: draft.rExtension ?? C02_POLICY.rExtension,
    packetM,
    widthW: draft.widthW ?? C02_POLICY.widthW,
    workLimit: draft.workLimit ?? decisionWorkLimit(k, packetM),
    envelopeBytes: draft.envelopeBytes ?? C02_POLICY.envelopeBytes,
    enumeration: draft.enumeration ?? recognizeEnumeration(text),
    exactAggregate: draft.exactAggregate ?? recognizeExactAggregate(text),
    diagnostics: draft.diagnostics === true,
    deliveryPath: draft.deliveryPath ?? null,
    obligations: copyObligations(draft),
    familyCaps: copyFamilyCaps(draft)
  });
  const digest = hashConditionDigest({
    principal: spec.principal,
    authorized_scopes: spec.authorizedScopes,
    explicit_bridges: [],
    workspace_project: spec.workspaceId,
    effective_as_of: spec.asOf,
    query_task_factors: [spec.text],
    governance_state: "open",
    activation_budget: spec.k,
    token_budget: spec.tokenBudget
  }, sha256);
  return Object.freeze({ spec, digest });
}
