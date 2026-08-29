import { freezeShadow, requireNonemptyString, ShadowContractError } from
  "../envelope.js";
import {
  CORRELATION_STATES,
  type BindingRelationWitness,
  type CorrelationState,
  type CorrelationWitness
} from "../witness/index.js";
import { freezeEndpoint, parseSupportNodeId } from "./identity.js";
import { assertEdgeIncidence } from "./incidence.js";
import {
  SUPPORT_EDGE_KINDS,
  SUPPORT_NODE_KINDS,
  type SupportAliasRecordV1,
  type SupportCorrelationRecordV1,
  type SupportEdgeKind,
  type SupportEdgeV1,
  type SupportNodeKind,
  type SupportNodeV1
} from "./types.js";

export function parseNode(input: unknown): SupportNodeV1 {
  const record = asRecord(input, "support node");
  const kind = parseNodeKind(record.kind);
  return freezeShadow({
    kind,
    id: parseSupportNodeId(kind, record.id)
  });
}

export function parseEdge(input: unknown): SupportEdgeV1 {
  const record = asRecord(input, "support edge");
  const kind = parseEdgeKind(record.kind);
  const from = parseEndpoint(record.from, "from");
  const to = parseEndpoint(record.to, "to");
  assertEdgeIncidence(kind, from, to);
  if (kind === "correlated" && to.id < from.id) {
    return freezeShadow({ kind, from: to, to: from });
  }
  return freezeShadow({ kind, from, to });
}

export function aliasRecord(witness: BindingRelationWitness): SupportAliasRecordV1 {
  assertExactPair(witness.epistemic.kind, "alias");
  const payload = witness.payload;
  if (payload === null) {
    throw new ShadowContractError("alias witness requires binding pair ids");
  }
  const left = requireNonemptyString(payload.left_id, "alias left_id");
  const right = requireNonemptyString(payload.right_id, "alias right_id");
  const ordered = left <= right ? [left, right] : [right, left];
  return freezeShadow({
    left_id: ordered[0]!,
    right_id: ordered[1]!,
    state: payload.state
  });
}

export function correlationRecord(
  witness: CorrelationWitness
): SupportCorrelationRecordV1 {
  assertExactPair(witness.epistemic.kind, "correlation");
  const payload = witness.payload;
  if (payload === null) {
    throw new ShadowContractError("correlation witness requires evidence pair ids");
  }
  if (!CORRELATION_STATES.includes(payload.state as CorrelationState)) {
    throw new ShadowContractError("unknown correlation state");
  }
  const left = requireNonemptyString(payload.left_id, "correlation left_id");
  const right = requireNonemptyString(payload.right_id, "correlation right_id");
  const ordered = left <= right ? [left, right] : [right, left];
  return freezeShadow({
    left_id: ordered[0]!,
    right_id: ordered[1]!,
    state: payload.state
  });
}

function parseEndpoint(input: unknown, label: string): SupportEdgeV1["from"] {
  const record = asRecord(input, label);
  const kind = parseNodeKind(record.kind);
  return freezeEndpoint(kind, requireNonemptyString(record.id, `${label} id`));
}

function parseNodeKind(value: unknown): SupportNodeKind {
  if (typeof value !== "string" || !SUPPORT_NODE_KINDS.includes(value as SupportNodeKind)) {
    throw new ShadowContractError("unknown support node kind");
  }
  return value as SupportNodeKind;
}

function parseEdgeKind(value: unknown): SupportEdgeKind {
  if (typeof value !== "string" || !SUPPORT_EDGE_KINDS.includes(value as SupportEdgeKind)) {
    throw new ShadowContractError("unknown support edge kind");
  }
  return value as SupportEdgeKind;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShadowContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactPair(kind: string, label: string): void {
  if (kind !== "exact") {
    throw new ShadowContractError(`${label} witness must be exact, not ${kind}`);
  }
}
