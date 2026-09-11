import { createHash } from "node:crypto";
import { productSubjectId, type ClaimState, type FieldValue, type IndexRole, type Proposition, type SupportRecord } from "@do-soul/alaya-protocol";
import { applyEvidenceEffect, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { parseBindingContext } from "../conditional-field/engine/binding-environment.js";
import { productStateNodeId } from "../conditional-field/reference/bind-max-min.js";
import { assessEvidence, observationsFromOwners, type RelationAssertionRead } from "../conditional-field/evidence/assess-support.js";
import type { EvidenceAccess } from "../conditional-field/evidence/types.js";
import { prepareProductEvidence } from "../conditional-field/evidence/product-evidence.js";
import { orderedProjectionValues } from "../conditional-field/engine/field-solve.js";
import type { RelationObserverRow } from "../conditional-field/observers/observe.js";

export function assessUnknownCause(state: FieldEngineState, input: { readonly as_of: string }): FieldEngineState {
  if ((state.observed_relations?.length ?? 0) === 0 && (state.interpretation.view.claim_demands?.length ?? 0) === 0) {
    return applyEvidenceEffect(state, { support: [], work_status: "complete" });
  }
  const references = [state.query_id, state.snapshot_id, input.as_of,
    state.observed_relations, state.transitions, state.transition_derivations, state.derivations, state.ordered_identities];
  const same = state.support_dependency_revision !== undefined
    && references.every((reference, index) => reference === state.support_dependency_references?.[index]);
  if (same && state.support_work_status === "complete") return state;
  const dependencyRevision = same ? state.support_dependency_revision! : `support-generation:${Number(state.support_dependency_revision?.split(":").at(-1) ?? 0) + 1}`;
  const claims = new Map<string, ClaimState>(same ? state.claims : []);
  const propositions = new Map<string, Proposition>(same ? state.claim_propositions : []);
  let propositionChanged = !same;
  const progress = { ...same ? state.support_progress : {} };
  const dependencies = { ...same ? state.support_dependencies : {} };
  const support = new Map((same ? state.support : []).map((record) => [record.proposition_id, record]));
  let remaining = state.remaining_exploration;
  let memory = state.remaining_memory_bytes + (same ? 0 : state.support_retained_bytes ?? 0);
  let retainedBytes = same ? state.support_retained_bytes ?? 0 : 0;
  let offset = same ? state.support_scan_offset ?? 0 : 0;
  const fallback = state.binding.kind === "bound" && state.ordered_identities === undefined ? state.binding.snapshot.values : [];
  const values = orderedProjectionValues(state) ?? { size: fallback.length, at: (index: number) => fallback[index] };
  while (offset < values.size && remaining > 0) {
    remaining -= 1;
    const value = values.at(offset)!;
    if (!value.accepting || value.activation?.kind === "unreachable" || value.milligrades === undefined) { offset += 1; continue; }
    const key = productStateNodeId(value.state);
    if (progress[key]?.complete) { offset += 1; continue; }
    const claim = claimForProduct(state, value);
    const prepared = prepareProductEvidence({ state, value, claimKind: claim.causeDemand ? claim.claimKind : undefined,
      causeSource: claim.causeDemand ? claim.arguments_[0] : undefined, progress: progress[key]?.cursor,
      workLimit: remaining, memoryLimit: memory });
    remaining -= prepared.work;
    if (prepared.rows.length === 0 && !prepared.complete) {
      progress[key] = { cursor: prepared.progress, complete: false };
      memory -= prepared.retained_bytes; retainedBytes += prepared.retained_bytes;
      break;
    }
    const demand = evidenceDemandForProduct(state, value, input.as_of, prepared.rows, prepared.progress.assertion_ids);
    const { id, context, observations, demands, required, dependencyIds } = demand;
    if (required > remaining) break;
    const assessed = assessEvidence({ ...context, observations, propositions: demands, work_limit: required });
    remaining -= required;
    const records = assessed.records.map((record) => mergeSupportRecord(support.get(record.proposition_id), record));
    const proposition = demands.find((item) => item.proposition.proposition_id === id)!.proposition;
    const bytes = records.reduce((sum, record) => sum + Math.max(0, Buffer.byteLength(JSON.stringify(record))
      - Buffer.byteLength(JSON.stringify(support.get(record.proposition_id) ?? null))), 0)
      + (progress[key] === undefined ? Buffer.byteLength(JSON.stringify(proposition)) + 100 : 0);
    if (bytes + prepared.retained_bytes > memory) break;
    memory -= bytes + prepared.retained_bytes;
    retainedBytes += bytes + prepared.retained_bytes;
    for (const record of records) support.set(record.proposition_id, record);
    if (propositions.get(key)?.proposition_id !== proposition.proposition_id) {
      propositions.set(key, proposition); propositionChanged = true;
    }
    claims.set(key, support.get(id)?.claim ?? "unknown");
    dependencies[key] = [...new Set([...(dependencies[key] ?? []), ...dependencyIds])];
    progress[key] = { cursor: prepared.progress, complete: prepared.complete };
    if (prepared.complete) offset += 1;
  }
  const complete = offset === values.size;
  const next = applyEvidenceEffect({ ...state, support: [], remaining_exploration: remaining, remaining_memory_bytes: memory },
    { support: [...support.values()], claims, work_status: complete ? "complete" : "open" });
  return { ...next, claim_propositions: propositionChanged ? propositions : state.claim_propositions, support_progress: progress,
    support_scan_offset: offset, support_completed_work: (state.support_completed_work ?? 0) + state.remaining_exploration - remaining,
    support_dependency_revision: dependencyRevision, support_dependency_references: references,
    support_dependencies: dependencies, support_retained_bytes: retainedBytes };
}

function mergeSupportRecord(prior: SupportRecord | undefined, next: SupportRecord): SupportRecord {
  const states = [prior?.claim, next.claim];
  const supported = states.includes("supported") || states.includes("conflict");
  const refuted = states.includes("refuted") || states.includes("conflict");
  return { ...next, claim: supported && refuted ? "conflict" : supported ? "supported" : refuted ? "refuted" : "unknown",
    witnesses: [...new Map([...(prior?.witnesses ?? []), ...next.witnesses].map((witness) => [witness.witness_id, witness])).values()] };
}

export function rolesFrom(state: FieldEngineState): Readonly<{ get(id: string): IndexRole | undefined }> {
  return { get: (id) => state.retained_index?.seeds.has(id) ? "requested" : state.roles.get(id) ?? "associated" };
}

function claimForProduct(state: FieldEngineState, value: FieldValue) {
  const env = parseBindingContext(value.state.binding_context);
  const claimDemand = state.interpretation.view.claim_demands?.find((demand) => env.get(demand.variable) === productSubjectId(value.state));
  const causeDemand = claimDemand !== undefined;
  const claimKind = claimDemand?.proposition_kind ?? "association";
  const arguments_ = claimDemand?.argument_variables.map((variable) => env.get(variable) ?? "unbound") ?? [productSubjectId(value.state)];
  return { causeDemand, claimKind, arguments_ };
}

function evidenceDemandForProduct(state: FieldEngineState, value: FieldValue, asOf: string,
  rows: readonly RelationObserverRow[], assertionIds: Readonly<{ has(id: string): boolean }>) {
  const key = productStateNodeId(value.state);
  const { causeDemand, claimKind, arguments_ } = claimForProduct(state, value);
  const assertions: RelationAssertionRead[] = rows.flatMap((row) => {
    const receipts = row.evidenceReceipts ?? [];
    const formation = formationReceiptFromRow(row);
    return row.validity === undefined ? [] : [{
      assertion_id: row.assertionId, relation_kind: row.predicate, validity: row.validity,
      anchors: { source_anchor: { kind: "object" as const, object_id: row.sourceObjectId }, target_anchor: { kind: "object" as const, object_id: row.targetObjectId } },
      evidence_receipts: receipts.map((receipt) => ({ evidence_id: receipt.evidenceId,
        source_event_anchor: { event_id: receipt.eventId, event_type: receipt.eventType, occurred_at: receipt.occurredAt } })),
      ...(formation === undefined ? {} : { formation_receipt: formation })
    }];
  });
  const id = `sha256:${createHash("sha256").update(JSON.stringify([claimKind, key])).digest("hex")}`;
  const associationId = `sha256:${createHash("sha256").update(JSON.stringify(["association", key])).digest("hex")}`;
  const accessIds = rows.flatMap((row) => [
    row.sourceObjectId,
    row.targetObjectId,
    ...(row.evidenceReceipts ?? []).map((receipt) => receipt.evidenceId)
  ]);
  const context = { query_id: state.query_id, snapshot_id: state.snapshot_id,
    hypothesis_id: value.state.hypothesis_id, binding_context: value.state.binding_context, time_state: value.state.time_state,
    jurisdiction: "workspace", as_of: asOf,
    permitted_timeless_policy_ids: new Set(assertions.flatMap((assertion) => assertion.validity.kind === "timeless" ? [assertion.validity.governance_policy_id] : [])), assertions,
    claims: [], access: accessFromLiveFacts(state, accessIds) };
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
  return { key, id, context, observations, demands, required,
    dependencyIds: rows.flatMap((row) => [row.assertionId, ...(row.evidenceReceipts ?? []).flatMap((receipt) => [receipt.evidenceId, receipt.eventId])]) };
}

function formationReceiptFromRow(row: RelationObserverRow): RelationAssertionRead["formation_receipt"] | undefined {
  const observations = row.sourceObservations;
  if (observations === undefined || observations.length === 0) return undefined;
  return { source_observations: observations };
}

function accessFromLiveFacts(state: FieldEngineState, ids: readonly string[]): Map<string, EvidenceAccess> {
  const access = new Map<string, EvidenceAccess>();
  for (const id of ids) {
    access.set(id, accessDecision(state.authorized_scopes, state.source_facts?.get(id)?.scope_class));
  }
  return access;
}

function accessDecision(
  authorized: readonly string[] | null | undefined,
  scopeClass: string | undefined
): EvidenceAccess {
  if (authorized === null) return "eligible";
  if (authorized === undefined || authorized.length === 0) return "ineligible";
  if (scopeClass !== undefined && authorized.includes(scopeClass)) return "eligible";
  return "ineligible";
}
