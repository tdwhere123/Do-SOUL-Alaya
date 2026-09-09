import { createHash } from "node:crypto";
import { productSubjectId, type ClaimState, type FieldValue, type IndexRole, type Proposition, type SupportRecord } from "@do-soul/alaya-protocol";
import { applyEvidenceEffect, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { parseBindingContext } from "../conditional-field/engine/binding-environment.js";
import { productStateNodeId } from "../conditional-field/reference/bind-max-min.js";
import { transitionKey } from "../conditional-field/engine/path-composition.js";
import { assessEvidence, observationsFromOwners, type RelationAssertionRead } from "../conditional-field/evidence/assess-support.js";

export function assessUnknownCause(state: FieldEngineState, input: { readonly as_of: string }): FieldEngineState {
  if ((state.observed_relations?.length ?? 0) === 0 && (state.interpretation.view.claim_demands?.length ?? 0) === 0) {
    return applyEvidenceEffect(state, { support: [], work_status: "complete" });
  }
  const count = (state.observed_relations ?? []).reduce((sum, row) => sum + 1 + (row.evidenceReceipts?.length ?? 0), 0);
  const same = state.support_observation_count === count;
  const claims = new Map<string, ClaimState>(same ? state.claims : []);
  const propositions = new Map<string, Proposition>(same ? state.claim_propositions : []);
  const progress = { ...same ? state.support_progress : {} };
  const support = new Map((same ? state.support : []).map((record) => [record.proposition_id, record]));
  let remaining = state.remaining_exploration;
  let memory = state.remaining_memory_bytes + (same ? 0 : state.support_retained_bytes ?? 0);
  let retainedBytes = same ? state.support_retained_bytes ?? 0 : 0;
  let complete = true;
  for (const value of state.binding.kind === "bound" ? state.binding.snapshot.values : []) {
    if (!value.accepting || (value.milligrades ?? 0) <= 0) continue;
    const key = productStateNodeId(value.state);
    if (progress[key]?.complete) continue;
    const demand = evidenceDemandForProduct(state, value, input.as_of, progress[key]?.offset ?? 0, Math.max(0, Math.floor((remaining - 2) / 8)));
    const { id, context, observations, demands, required, nextOffset, receiptCount } = demand;
    if (required > remaining || nextOffset === (progress[key]?.offset ?? 0) && receiptCount > nextOffset) { complete = false; continue; }
    const assessed = assessEvidence({ ...context, observations, propositions: demands, work_limit: required });
    remaining -= required;
    const records = assessed.records.map((record) => mergeSupportRecord(support.get(record.proposition_id), record));
    const proposition = demands.find((item) => item.proposition.proposition_id === id)!.proposition;
    const bytes = records.reduce((sum, record) => sum + Math.max(0, Buffer.byteLength(JSON.stringify(record))
      - Buffer.byteLength(JSON.stringify(support.get(record.proposition_id) ?? null))), 0)
      + (progress[key] === undefined ? Buffer.byteLength(JSON.stringify(proposition)) + 100 : 0);
    if (bytes > memory) { complete = false; continue; }
    memory -= bytes;
    retainedBytes += bytes;
    for (const record of records) support.set(record.proposition_id, record);
    propositions.set(key, proposition);
    claims.set(key, support.get(id)?.claim ?? "unknown");
    progress[key] = { offset: nextOffset, complete: nextOffset >= receiptCount };
    if (!progress[key]!.complete) complete = false;
  }
  const next = applyEvidenceEffect({ ...state, support: [], claims, remaining_exploration: remaining, remaining_memory_bytes: memory },
    { support: [...support.values()], claims, work_status: complete ? "complete" : "open" });
  return { ...next, claim_propositions: propositions, support_progress: progress, support_observation_count: count, support_retained_bytes: retainedBytes };
}

function mergeSupportRecord(prior: SupportRecord | undefined, next: SupportRecord): SupportRecord {
  const states = [prior?.claim, next.claim];
  const supported = states.includes("supported") || states.includes("conflict");
  const refuted = states.includes("refuted") || states.includes("conflict");
  return { ...next, claim: supported && refuted ? "conflict" : supported ? "supported" : refuted ? "refuted" : "unknown",
    witnesses: [...new Map([...(prior?.witnesses ?? []), ...next.witnesses].map((witness) => [witness.witness_id, witness])).values()] };
}

export function rolesFrom(state: FieldEngineState,
  overlay: Readonly<Record<string, { readonly role: IndexRole }>> = {}): ReadonlyMap<string, IndexRole> {
  const roles = new Map<string, IndexRole>();
  for (const identity of state.seen_identities) roles.set(productStateNodeId(identity), "associated");
  for (const transition of state.transitions) {
    if (overlay[transition.relation_kind]?.role === "routing_only") roles.set(productStateNodeId(transition.to), "routing_only");
  }
  for (const seed of state.seeds) roles.set(productStateNodeId(seed.state), "requested");
  return roles;
}

function evidenceDemandForProduct(state: FieldEngineState, value: FieldValue, asOf: string, offset: number, limit: number) {
  const key = productStateNodeId(value.state);
  const env = parseBindingContext(value.state.binding_context);
  const claimDemand = state.interpretation.view.claim_demands?.find((demand) => env.get(demand.variable) === productSubjectId(value.state));
  const causeDemand = claimDemand !== undefined;
  const claimKind = claimDemand?.proposition_kind ?? "association";
  const arguments_ = claimDemand?.argument_variables.map((variable) => env.get(variable) ?? "unbound") ?? [productSubjectId(value.state)];
  const assertionIds = new Set(state.transitions.filter((transition) => productStateNodeId(transition.to) === key)
    .flatMap((transition) => state.derivations.find((root) => root.derivation_id === state.transition_derivations[transitionKey(transition)])?.leaf_ids ?? []));
  const rows = (state.observed_relations ?? []).filter((row) => row.targetObjectId === productSubjectId(value.state)
    && (assertionIds.has(row.assertionId) || causeDemand && row.predicate === claimKind && row.sourceObjectId === arguments_[0]));
  const receiptCount = rows.reduce((sum, row) => sum + (row.evidenceReceipts?.length ?? 0), 0);
  const nextOffset = Math.min(receiptCount, offset + limit);
  let passed = 0;
  const assertions: RelationAssertionRead[] = rows.flatMap((row) => {
    const receipts = row.evidenceReceipts ?? [];
    const selected = receipts.slice(Math.max(0, offset - passed), Math.max(0, nextOffset - passed));
    passed += receipts.length;
    return row.validity === undefined ? [] : [{
      assertion_id: row.assertionId, relation_kind: row.predicate, validity: row.validity,
      anchors: { source_anchor: { kind: "object" as const, object_id: row.sourceObjectId }, target_anchor: { kind: "object" as const, object_id: row.targetObjectId } },
      evidence_receipts: selected.map((receipt) => ({ evidence_id: receipt.evidenceId,
        source_event_anchor: { event_id: receipt.eventId, event_type: receipt.eventType, occurred_at: receipt.occurredAt } }))
    }];
  });
  const id = `sha256:${createHash("sha256").update(JSON.stringify([claimKind, key])).digest("hex")}`;
  const associationId = `sha256:${createHash("sha256").update(JSON.stringify(["association", key])).digest("hex")}`;
  const context = { query_id: state.query_id, snapshot_id: state.snapshot_id, source_revision: state.snapshot_id,
    hypothesis_id: value.state.hypothesis_id, binding_context: value.state.binding_context, time_state: value.state.time_state,
    jurisdiction: "workspace", as_of: asOf,
    permitted_timeless_policy_ids: new Set(assertions.flatMap((assertion) => assertion.validity.kind === "timeless" ? [assertion.validity.governance_policy_id] : [])), assertions,
    claims: [], access: new Map() };
  const observations = observationsFromOwners(context).flatMap((observation) => {
    const row = rows.find((row) => row.assertionId === observation.proposition_id)!;
    return [
      ...(assertionIds.has(row.assertionId) ? [{ ...observation, proposition_id: associationId }] : []),
      ...(causeDemand && row.predicate === claimKind && row.sourceObjectId === arguments_[0] ? [{ ...observation, proposition_id: id }] : [])
    ];
  });
  const demands = (causeDemand ? [[associationId, "association"], [id, claimKind]] : [[id, "association"]]).map(([propositionId, kind]) => ({
    proposition: { schema_version: 1 as const, proposition_id: propositionId!, kind: kind!, arguments: propositionId === id ? arguments_ : [productSubjectId(value.state)] },
    templates: assertions.filter((assertion) => observations.some((row) => row.proposition_id === propositionId
      && assertion.evidence_receipts.some((receipt) => receipt.evidence_id === row.evidence_id)))
      .flatMap((assertion) => assertion.evidence_receipts.map((receipt) => ({ witness_id: receipt.evidence_id,
        premises: [rows.find((row) => row.assertionId === assertion.assertion_id)!.sourceObjectId, productSubjectId(value.state)], cost: 1 })))
  }));
  const required = observations.length + demands.length + demands.reduce((sum, demand) => sum + demand.templates.length * 2, 0);
  return { key, id, context, observations, demands, required, nextOffset, receiptCount };
}
