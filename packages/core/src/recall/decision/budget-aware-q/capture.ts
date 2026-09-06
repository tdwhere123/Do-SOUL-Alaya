import { compileRecallQueryProbes, type RecallQueryProbes } from "../../query/recall-query-probes.js";
import { compileRelationQuery, type RelationQuery } from "../../query/recall-relation-query.js";
import { detachInput } from "./capture-data.js";
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
  readonly probes: Readonly<RecallQueryProbes>;
  readonly spec: QuerySpec;
  readonly digest: string;
}

function copyStrings(values: readonly string[] | undefined, fallback: readonly string[]): readonly string[] {
  return Object.freeze(Array.from(values ?? fallback, (value) => String(value)));
}

function copyObligations(draft: QuerySpecDraft): QuerySpec["obligations"] {
  const unique = new Map<string, QuerySpec["obligations"][number]>();
  for (const obligation of draft.obligations ?? []) {
    if (obligation.supportForm !== undefined && obligation.supportForm !== "endpoint_path") throw new Error("unsupported obligation support form");
    const copy = Object.freeze({
      kind: String(obligation.kind),
      ...(obligation.supportForm === "endpoint_path" ? { supportForm: "endpoint_path" as const } : {}),
      bindingSlot: String(obligation.bindingSlot), assignmentKey: String(obligation.assignmentKey),
      requiredPredicates: Object.freeze(Array.from(obligation.requiredPredicates, (item) => String(item)))
    });
    const identity = JSON.stringify([copy.kind, copy.bindingSlot, copy.assignmentKey]);
    const previous = unique.get(identity);
    if (previous && (previous.supportForm !== copy.supportForm ||
      JSON.stringify(previous.requiredPredicates) !== JSON.stringify(copy.requiredPredicates))) {
      throw new Error("conflicting obligation identity definition");
    }
    if (!previous) unique.set(identity, copy);
  }
  return Object.freeze([...unique.values()]);
}

function relationObligations(query: RelationQuery, text: string): QuerySpecDraft["obligations"] {
  if (!query.supported) return [];
  const typed = query.subject !== null || query.wantsChannel ||
    /\bown|\bowner|\bowned|\bescalation|\bchannel\b/iu.test(text);
  if (!typed) return [];
  return [{
    kind: query.wantsChannel ? "conjunction" : "relation",
    ...(query.wantsChannel ? { supportForm: "endpoint_path" as const } : {}),
    bindingSlot: query.wantsChannel ? "owner_and_channel" : "owner",
    assignmentKey: query.subject === null ? "owner" : `owner:${query.subject}`,
    requiredPredicates: query.wantsChannel ? ["owns", "escalation_channel"] : ["owns"]
  }];
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
  now: () => string,
  availability: Readonly<{ embedding?: boolean }> = {}
): CapturedQuery {
  draft = detachInput(draft);
  const text = String(draft.text);
  if (Buffer.byteLength(text, "utf8") > 8192) throw new Error("query text exceeds bounded capture profile");
  const probes = detachInput(compileRecallQueryProbes(text));
  const asOf = String(draft.asOf ?? now());
  const relationQuery = compileRelationQuery(probes, asOf);
  const unsupportedTemporalOperator = relationQuery.temporal.kind === "unsupported";
  const k = draft.k ?? C02_POLICY.kDefault;
  const packetM = draft.packetM ?? C02_POLICY.packetM;
  const spec: QuerySpec = Object.freeze({
    text,
    unsupportedTemporalOperator,
    unsupportedRelationOperator: !relationQuery.supported,
    relationQuery,
    perDimensionLimits: draft.perDimensionLimits ?? null,
    principal: String(draft.principal ?? "agent"),
    workspaceId: String(draft.workspaceId ?? "workspace-1"),
    authorizedScopes: copyStrings(draft.authorizedScopes, [draft.workspaceId ?? "workspace-1"]),
    asOf,
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
    obligations: copyObligations({ ...draft, obligations: draft.obligations ?? relationObligations(relationQuery, text) }),
    familyCaps: Object.freeze({ ...copyFamilyCaps(draft),
      ...(draft.familyCaps?.embedding === "ready" && availability.embedding === false ? { embedding: "unavailable" as const } : {}),
      ...(unsupportedTemporalOperator || !relationQuery.supported ? { typed_relation: "unavailable" as const } : {}) })
  });
  for (const key of ["k", "tokenBudget", "nBase", "nExtension", "rBase", "rExtension",
    "packetM", "widthW", "workLimit", "envelopeBytes"] as const) {
    if (!Number.isSafeInteger(spec[key]) || spec[key] < 0) throw new Error(`invalid ${key}`);
  }
  if (!spec.principal || !spec.workspaceId || !spec.authorizedScopes.length ||
      !spec.authorizedScopes.includes(spec.workspaceId)) throw new Error("invalid query jurisdiction");
  if (!Number.isFinite(Date.parse(spec.asOf))) throw new Error("invalid query as-of");
  for (const capability of Object.values(spec.familyCaps)) {
    if (!["ready", "unavailable", "pending", "not_requested"].includes(capability)) {
      throw new Error("invalid family capability");
    }
  }
  for (const limit of Object.values(spec.perDimensionLimits ?? {})) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("invalid dimension limit");
  }
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
  return Object.freeze({ spec, digest, probes });
}
