import {
  canonicalJson, sameRecallTarget, sourceEvidenceRootTarget,
  SourceSemanticResourceExhausted, type SourceSemanticResourceLedger, type SourceSemanticLibraryProof,
  type SourceSemanticBindingResult, type SourceSemanticConsumedLeaf, type SourceEvidenceTarget
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { traceDerivationForest, localLeafIds } from "../engine/derivation-provenance.js";

type Role = Readonly<{ variable: string; query_slot: string; source_slot: string }>;
type Frame = Readonly<{ query_frame: string; source_frame: string }>;
type Key = Readonly<Record<"kind" | "issuer" | "project" | "normalization" | "value", Role>>;
type Local = Readonly<{ interpretation_id: string; semantic_correspondence_id: string;
  source_target: SourceEvidenceTarget; alternative: number; input: number }>;
/** Selected semantic premises, not a source-fidelity certificate or a public query language. */
export type SourceSemanticJointSelection = Readonly<{
  contract: "private-two-h-chronology-v1"; query_semantics_id: string;
  seed: Local & Readonly<{ bridge: Frame; review: Frame; module: Role; review_module: Role;
    ticket: Key; time: Role & Readonly<{ basis: "source_event_explicit_offset" }> }>;
  approval: Local & Readonly<{ frame: Frame; ticket: Key;
    time: Role & Readonly<{ basis: "source_event_explicit_offset" }> }>;
}>;
/** Only the native library execution owner supplies these, after current-source verification. */
export type SourceSemanticJointLocal = Readonly<{ proof: SourceSemanticLibraryProof; source: string }>;
type Operand = Readonly<{ value: string; node: string;
  mentions: readonly Readonly<{ id: string; span: readonly [number, number]; text: string }>[] }>;
type Closure = Readonly<{ proof_identity: string; binding_id: string; explanation_ids: readonly string[];
  observations: readonly Readonly<{ observation_id: string; leaf: SourceSemanticConsumedLeaf }>[] }>;
export type SourceSemanticJointAssessment = Readonly<{
  contract: "private-two-h-chronology-assessment-v1"; semantic_status: "unreviewed"; world_claim: "unknown";
  status: "witnessed" | "unresolved" | "not_lowered" | "invalid" | "resource_exhausted"; reason: string;
  witness: null | Readonly<{ witness_id: string; selection: SourceSemanticJointSelection; snapshot_id: string; as_of: string;
    source_targets: readonly SourceEvidenceTarget[]; locals: readonly Closure[];
    module: string; ticket: Readonly<Record<keyof Key, string>>;
    approval_times: readonly Operand[]; review_times: readonly Operand[] }>;
}>;
class Unresolved extends Error {}
class Unsupported extends Error {}
const components = ["kind", "issuer", "project", "normalization", "value"] as const;

/** One licensed rule: Bridge(M,K) AND Review(M,ER) AND Approval(K,EA) AND EA < ER.
 * No namespace defaults, aliases, event identity, global graph, cache, or world-claim promotion.
 * The role mappings themselves remain explicit unreviewed conditional premises. */
export function assessSourceSemanticJointWitness(input: Readonly<{
  selection: SourceSemanticJointSelection; locals: readonly SourceSemanticJointLocal[];
  snapshot_id: string; as_of: string; meter: SourceSemanticResourceLedger;
}>): SourceSemanticJointAssessment {
  const { selection: s, meter } = input;
  const result = (status: SourceSemanticJointAssessment["status"], reason: string,
    witness: SourceSemanticJointAssessment["witness"] = null): SourceSemanticJointAssessment => ({
    contract: "private-two-h-chronology-assessment-v1", semantic_status: "unreviewed", world_claim: "unknown", status, reason, witness
  });
  try {
    meter.retain(s, "private joint selected premises");
    if (s.contract !== "private-two-h-chronology-v1" || s.seed.interpretation_id === s.approval.interpretation_id
      || s.seed.module.variable !== s.seed.review_module.variable || s.seed.alternative !== s.approval.alternative
      || s.seed.input === s.approval.input || s.seed.bridge.source_frame === s.seed.review.source_frame
      || new Set([s.seed.bridge.query_frame, s.seed.review.query_frame, s.approval.frame.query_frame]).size !== 3) {
      return result("invalid", "two_context_shared_module_selection_required");
    }
    const seed = selectedLocal(input.locals, s.seed, s.query_semantics_id, meter);
    const approval = selectedLocal(input.locals, s.approval, s.query_semantics_id, meter);
    let lastReason = "selected_local_binding_absent";
    for (const a of selectedBindings(seed, s.seed)) for (const b of selectedBindings(approval, s.approval)) {
      meter.charge(1, 128, "private joint binding pair");
      try {
        const ac = closure(seed.proof, a, meter), bc = closure(approval.proof, b, meter);
        const bridge = frame(seed, a, ac, s.seed.bridge, meter), review = frame(seed, a, ac, s.seed.review, meter);
        const approved = frame(approval, b, bc, s.approval.frame, meter);
        const module = operand(seed, a, ac, bridge, s.seed.module, meter);
        const reviewModule = operand(seed, a, ac, review, s.seed.review_module, meter);
        if (module[0]!.node !== reviewModule[0]!.node) throw new Unresolved("module_binding_mismatch");
        const key = ticket(seed, a, ac, bridge, s.seed.ticket, meter);
        const other = ticket(approval, b, bc, approved, s.approval.ticket, meter);
        if (components.some(k => key[k] !== other[k])) throw new Unresolved("qualified_ticket_key_mismatch");
        const before = operand(approval, b, bc, approved, s.approval.time, meter);
        const after = operand(seed, a, ac, review, s.seed.time, meter);
        const ea = before.map(x => instant(x.value)), er = after.map(x => instant(x.value));
        if (!ea.every(x => er.every(y => x < y))) throw new Unresolved("strict_precedence_unresolved");
        const material = { selection: s, snapshot_id: input.snapshot_id, as_of: input.as_of,
          source_targets: [seed.proof.source_target!, approval.proof.source_target!], locals: [ac, bc],
          module: module[0]!.node, ticket: key, approval_times: before, review_times: after };
        meter.retain(material, "private joint complete dependency closure");
        const bytes = meter.canonicalJsonLength(material);
        meter.charge(bytes, bytes * 2, "private joint witness identity");
        return result("witnessed", "conditional_linked_approval_precedes_review", {
          witness_id: `sha256:${fieldContractSha256(canonicalJson(material))}`, ...material
        });
      } catch (error) {
        if (error instanceof Unsupported) return result("not_lowered", error.message);
        if (!(error instanceof Unresolved)) throw error;
        lastReason = error.message;
      }
    }
    return result("unresolved", lastReason);
  } catch (error) {
    if (error instanceof SourceSemanticResourceExhausted) return result("resource_exhausted", error.phase);
    if (error instanceof Unresolved) return result("unresolved", error.message);
    throw error;
  }
}

function selectedLocal(locals: readonly SourceSemanticJointLocal[], selected: Local, query: string,
  meter: SourceSemanticResourceLedger): SourceSemanticJointLocal {
  meter.charge(locals.length, locals.length * 8, "private joint executed local lookup");
  const found = locals.find(({ proof: p }) => p.source_interpretation_id === selected.interpretation_id
    && p.semantic_correspondence_id === selected.semantic_correspondence_id && p.query_semantics_id === query);
  if (found === undefined) throw new Unresolved("selected_local_not_executed");
  const p = found.proof;
  if (p.source_target === undefined || !sameRecallTarget(sourceEvidenceRootTarget(p.source_target), sourceEvidenceRootTarget(selected.source_target))
    || p.source_target.source_version !== p.interpretation.source.source_version
    || p.source_target.content_digest !== p.interpretation.source.content_digest) throw new Unresolved("selected_source_changed");
  if (p.outcome.status !== "interpreted" || p.completeness?.logical_index !== "complete") throw new Unresolved("local_execution_incomplete");
  return found;
}
function selectedBindings(local: SourceSemanticJointLocal, s: Local) {
  return (local.proof.binding_results ?? []).filter(b => b.kind === "evidence" && b.alternative === s.alternative && b.input === s.input);
}
function closure(proof: SourceSemanticLibraryProof, binding: SourceSemanticBindingResult, meter: SourceSemanticResourceLedger): Closure {
  const rows = proof.derivations ?? [], leaves = proof.evidence_leaves ?? [];
  meter.charge(rows.length + leaves.length, (rows.length + leaves.length) * 64, "private joint closure indexes");
  const traced = traceDerivationForest({ forest: new Map(rows.map(x => [x.derivation_id, x])), roots: binding.explanation_ids,
    maxVisits: meter.work });
  meter.charge(traced.work, traced.work * 128, "private joint closed derivation traversal");
  if (!traced.complete || binding.explanation_ids.length === 0) throw new Unresolved("local_closure_open");
  const ids = localLeafIds(traced.traversal), observations = leaves.filter(x => ids.has(x.observation_id));
  if (observations.length === 0) throw new Unresolved("local_semantic_origins_absent");
  return { proof_identity: proof.conditional_computation_id!, binding_id: binding.binding_id,
    explanation_ids: binding.explanation_ids, observations };
}
function frame(local: SourceSemanticJointLocal, binding: SourceSemanticBindingResult, c: Closure, selected: Frame,
  meter: SourceSemanticResourceLedger) {
  const p = local.proof, q = p.query.alternatives[binding.alternative];
  const qf = q?.frames.find(x => x.id === selected.query_frame), hf = p.interpretation.frames.find(x => x.id === selected.source_frame);
  meter.charge((q?.frames.length ?? 0) + p.interpretation.frames.length, 128, "private joint selected frame");
  if (p.query.gaps.some(g => g.affected_ids.includes(selected.query_frame))
    || p.interpretation.gaps.some(g => g.affected_ids.includes(selected.source_frame))) throw new Unresolved("selected_frame_has_unresolved_meaning");
  if (qf === undefined || hf === undefined || !q?.evidence_inputs?.[binding.kind === "evidence" ? binding.input : -1]?.frames.includes(qf.id)
    || binding.bindings[qf.variable]?.node_id !== hf.id) throw new Unresolved("selected_frame_not_bound");
  if (hf.context_owner.kind !== "source_act" || hf.context_owner.source_act !== "assertion"
    || !c.observations.some(x => x.leaf.leaf_kind === "source_interpretation_assertion_permission" && x.leaf.occurrence === hf.id)) {
    throw new Unsupported("nonasserted_event_context");
  }
  const predicate = c.observations.some(({ leaf }) => {
    const row = leaf.correspondence_index === undefined ? undefined : p.semantic_correspondence.correspondences[leaf.correspondence_index];
    return leaf.leaf_kind === "semantic_correspondence_predicate" && leaf.occurrence === hf.id
      && row?.query_endpoint.kind === "predicate" && row.query_endpoint.alternative === binding.alternative
      && row.query_endpoint.frame === qf.id && row.source_endpoint.kind === "frame" && row.source_endpoint.frame === hf.id;
  });
  if (!predicate) throw new Unresolved("selected_predicate_not_consumed");
  return { qf, hf };
}
function operand(local: SourceSemanticJointLocal, binding: SourceSemanticBindingResult, c: Closure,
  selected: ReturnType<typeof frame>, role: Role, meter: SourceSemanticResourceLedger): Operand[] {
  const p = local.proof, coordinate = binding.bindings[role.variable];
  if (coordinate === undefined || coordinate.packet_id !== p.source_interpretation_id
    || coordinate.hypothesis_id !== p.conditional_computation_id
    || !selected.qf.role_requirements.some(r => r.id === role.query_slot && r.target_variable === role.variable)
    || !selected.hf.bindings.some(r => r.slot_id === role.source_slot && r.target.kind === "node" && r.target.id === coordinate.node_id)) {
    throw new Unresolved("selected_role_not_bound");
  }
  if (p.query.gaps.some(g => g.affected_ids.includes(role.variable))
    || p.interpretation.gaps.some(g => g.affected_ids.some(id => [coordinate.node_id, role.source_slot].includes(id)))) {
    throw new Unresolved("selected_operand_has_unresolved_meaning");
  }
  const leaves = c.observations.map(x => x.leaf);
  const bound = leaves.some(x => x.leaf_kind === "source_interpretation_binding" && x.occurrence === selected.hf.id
    && x.slot_id === role.source_slot && x.target === coordinate.node_id);
  const aligned = leaves.some(x => {
    const row = x.correspondence_index === undefined ? undefined : p.semantic_correspondence.correspondences[x.correspondence_index];
    return x.leaf_kind === "semantic_correspondence_slot" && x.occurrence === selected.hf.id && x.slot_id === role.source_slot
      && row?.query_endpoint.kind === "slot" && row.query_endpoint.alternative === binding.alternative
      && row.query_endpoint.frame === selected.qf.id && row.query_endpoint.slot === role.query_slot
      && row.source_endpoint.kind === "slot" && row.source_endpoint.frame === selected.hf.id && row.source_endpoint.slot === role.source_slot;
  });
  if (!bound || !aligned) throw new Unresolved("selected_role_not_consumed");
  const referent = p.interpretation.referents.find(r => r.id === coordinate.node_id);
  if (referent?.referent_kind !== "grouped" || referent.mentions.length === 0) throw new Unsupported("operand_not_literal_grouped_referent");
  meter.charge(local.source.length + referent.mentions.length, local.source.length * 4 + referent.mentions.length * 128,
    "private joint exact operand bytes");
  const bytes = Buffer.from(local.source, "utf8");
  return referent.mentions.map(id => {
    const mention = p.interpretation.mentions.find(m => m.id === id);
    if (mention === undefined || mention.span_space !== "source_utf8"
      || bytes.subarray(mention.utf8_span[0], mention.utf8_span[1]).toString("utf8") !== mention.text) throw new Unresolved("operand_location_unverified");
    return { value: mention.text, node: coordinate.node_id,
      mentions: [{ id, span: mention.utf8_span, text: mention.text }] };
  });
}
function ticket(local: SourceSemanticJointLocal, binding: SourceSemanticBindingResult, c: Closure,
  selected: ReturnType<typeof frame>, key: Key, meter: SourceSemanticResourceLedger): Record<keyof Key, string> {
  const tuple = {} as Record<keyof Key, string>;
  for (const k of components) {
    const values = operand(local, binding, c, selected, key[k], meter).map(x => x.value);
    if (values.some(v => v !== values[0]) || values[0]!.trim().length === 0) throw new Unresolved("ticket_component_unknown");
    tuple[k] = values[0]!;
  }
  if (tuple.normalization !== "exact") throw new Unsupported("ticket_normalization_unsupported");
  return tuple;
}
function instant(text: string): number {
  // Strict explicit-offset instants only: no date-only, ranges, relative time or inferred ingestion clock.
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (match === null) throw new Unsupported("source_event_time_not_explicit_offset");
  if (match[6] === "-00:00") throw new Unsupported("source_event_time_offset_unknown");
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]
    || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
    || match[6] !== "Z" && (Number(match[6]!.slice(1, 3)) > 23 || Number(match[6]!.slice(4)) > 59)) {
    throw new Unsupported("source_event_time_invalid");
  }
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new Unsupported("source_event_time_invalid");
  return time;
}
