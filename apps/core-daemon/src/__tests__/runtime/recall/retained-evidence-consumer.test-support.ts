import {
  canonicalJson, hashContentDigest, projectSourceSemanticQuerySupport, proofForLibraryQualifier,
  SourceRecordIdentitySchema, SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  SoulInterpretationRecallDeliverySchema, sourceGoldRootIdentity, verifySourceRecordIdentity,
  type SourceEvidenceTarget, type SourceRecordIdentity, type SourceSemanticBindingResult,
  type SourceSemanticLibrarySlotQualifier, type SourceSemanticQuery, type SourceSemanticQuerySupport,
  type SourceSemanticResourceBudget
} from "@do-soul/alaya-protocol";
import { admitSourceSemanticQuery, deliveredSourceSemanticLibraryProof, fieldContractSha256 } from "@do-soul/alaya-core";
import { evaluateBooleanHypergraph } from "../../../../../../packages/graph-algorithms/src/boolean-hypergraph.js";
import { verifySourceSemanticLocations } from "../../../../../../packages/core/src/memory/evidence-create/source-semantic-location.js";
import { sliceUtf8Span } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { admitSourceSemanticLibraryResponse } from "../../../../../bench-runner/src/runs/measurement/source-semantic-library-measurement.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../../../bench-runner/src/runs/measurement/source-semantic-library-recall.js";
import type { FirstExposurePage } from "../../../../../bench-runner/src/runs/measurement/first-exposure-session.js";

export const RETAINED_CONSUMER_BUDGET = { work_units: 1_000_000, memory_bytes: 64_000_000 } as const;
export type TrustedConsumerSource = Readonly<{ record: SourceRecordIdentity; body: string }>;
export type RetainedConsumerPacket = Readonly<{
  original_query: string; query_semantics: unknown; encoded_response: string;
  sources: readonly TrustedConsumerSource[];
}>;
export type EvaluatorCompatibilityPremise = Readonly<{
  id: string; query_semantics_id: string; compatibility: "compatible" | "unknown" | "incompatible";
}>;
type Phase = "artifact_decode" | "input_decode" | "page_admission" | "source_binding" | "proof_verification"
  | "support_projection" | "conditional_evidence" | "output";
type Citation = Readonly<{
  alternative: number; input: number; delivery_id: string; slot: number; target: SourceEvidenceTarget;
  conditional_computation_id: string; binding_id: string; explanation_ids: readonly string[]; delivered_text: string;
}>;
type ConditionalReadout = Readonly<{
  premise: EvaluatorCompatibilityPremise; complete_alternatives: readonly number[];
  conditional_evidence_complete: boolean; citations: readonly Citation[];
}>;
type ProofAttempt = {
  slot: number; conditional_computation_id: string; allowance: SourceSemanticResourceBudget;
  resource_usage: SourceSemanticResourceBudget | null; status: "pending" | "verified" | "unverified";
};
type PacketReadout = {
  packet: number; status: "processing" | "completed"; query_semantics_id?: string; delivery_id?: string;
  offline_reader_exposure?: FirstExposurePage;
  native_qualifiers?: readonly SourceSemanticLibrarySlotQualifier[];
  native_proof_qualifications?: readonly Readonly<{ conditional_computation_id: string | undefined;
    semantic_status: string; conclusion_scope: string; world_claim: string }>[];
  proof_attempts: ProofAttempt[]; citations: Citation[]; support?: SourceSemanticQuerySupport;
  readouts: ConditionalReadout[];
};

/** One consumer allowance also reserves its bounded failure transcript. Child verifiers receive only remaining work. */
export class RetainedConsumerLedger extends SourceSemanticResourceLedger {
  phase: Phase = "input_decode";
  readonly costs = Object.fromEntries((["artifact_decode", "input_decode", "page_admission", "source_binding", "proof_verification",
    "support_projection", "conditional_evidence", "output"] as const).map(phase => [phase,
    { work_units: 0, memory_bytes: 0 }])) as Record<Phase, { work_units: number; memory_bytes: number }>;
  private readonly reportWork: number;
  private readonly reportBytes: number;
  constructor(readonly budget: SourceSemanticResourceBudget = RETAINED_CONSUMER_BUDGET) {
    super(budget);
    this.reportWork = Math.min(10_000, Math.floor(budget.work_units / 10));
    this.reportBytes = Math.min(1_000_000, Math.floor(budget.memory_bytes / 10));
  }
  override reserve(work: number, bytes: number, phase?: string): void {
    super.reserve(work + (this.phase === "output" ? 0 : this.reportWork),
      bytes + (this.phase === "output" ? 0 : this.reportBytes), phase);
  }
  override charge(work: number, bytes: number, phase?: string): void {
    super.charge(work, bytes, phase);
    this.costs[this.phase].work_units += work; this.costs[this.phase].memory_bytes += bytes;
  }
  allowance(): SourceSemanticResourceBudget {
    return { work_units: Math.max(0, this.work - this.reportWork), memory_bytes: Math.max(0, this.bytes - this.reportBytes) };
  }
}

export function readRetainedEvidence(packets: readonly RetainedConsumerPacket[],
  premises: readonly EvaluatorCompatibilityPremise[], budget: SourceSemanticResourceBudget | RetainedConsumerLedger = RETAINED_CONSUMER_BUDGET) {
  const meter = budget instanceof RetainedConsumerLedger ? budget : new RetainedConsumerLedger(budget);
  const observed: PacketReadout[] = [], roots = new Set<string>();
  let status: "completed" | "stopped" = "completed", failure: { packet: number; phase: Phase; reason: string } | null = null;
  let packetIndex = 0, proofCount = 0;
  try {
    meter.phase = "input_decode";
    if (packets.length < 1 || packets.length > 2 || premises.length < 1 || premises.length > 3) {
      throw new Error("consumer input exceeds the registered packet or premise bound");
    }
    meter.retain(premises, "external evaluator premises");
    for (const [position, packet] of packets.entries()) {
      packetIndex = position;
      const row: PacketReadout = { packet: position, status: "processing", proof_attempts: [], citations: [], readouts: [] };
      observed.push(row);
      const decoded = decodePacket(packet, meter);
      const admitted = admitPacket(packet, decoded, row, meter);
      for (const entry of admitted.delivery.index.entries) {
        if (entry.target.kind !== "source_evidence") throw new Error("consumer requires source evidence roots");
        const root = sourceGoldRootIdentity(entry.target);
        if (roots.has(root) || roots.size === 3) throw new Error("duplicate or excess delivered root");
        roots.add(root);
      }
      proofCount += admitted.delivery.qualifiers.filter(qualifier => qualifier.evidence_kind === "semantic_proof").length;
      if (proofCount > 3) throw new Error("consumer exceeds three delivered proofs");
      const bindings = verifyPacket(packet, admitted, row, meter);
      meter.phase = "support_projection";
      meter.charge(admitted.inputCount * (bindings.length + 1), admitted.inputCount * 128, "verified support projection");
      row.support = projectSourceSemanticQuerySupport(admitted.query, bindings);
      meter.phase = "conditional_evidence";
      for (const premise of premises) row.readouts.push(conditionalEvidence(admitted.query, admitted.queryId, row, premise, meter));
      row.status = "completed";
    }
  } catch (error) {
    status = "stopped";
    failure = { packet: packetIndex, phase: meter.phase, reason: String(error).slice(0, 2048) };
  }
  meter.phase = "output";
  const result = { contract: "retained-evidence-consumer-v1", status, failure, packets: observed,
    allowance: meter.budget, resource_usage: { work_units: meter.spentWork, memory_bytes: meter.spentBytes }, costs: meter.costs,
    exposure_authority: "new_offline_reader_encounter_only", input_encoding: "reconstructed_reader_input_not_captured_wire",
    conclusion_scope: "conditional_evidence_inputs_only", native_answer_upgrade: false, native_continuations_executed: 0,
    logical_cost_model: "bounded retention/copies, 64-code-unit decode blocks, projection scans and finite graph upper bounds",
    unmetered: ["Git guards and diagnostic file capture", "physical CPU, elapsed time, I/O and peak memory"] };
  try { meter.retain(result, "consumer result construction"); }
  catch (error) {
    result.status = "stopped";
    result.failure = { packet: packetIndex, phase: "output", reason: String(error).slice(0, 2048) };
  }
  result.resource_usage = { work_units: meter.spentWork, memory_bytes: meter.spentBytes };
  return result;
}

function decodePacket(packet: RetainedConsumerPacket, meter: RetainedConsumerLedger) {
  meter.phase = "input_decode";
  meter.retain(packet, "reader input retention");
  meter.charge(Math.ceil(packet.encoded_response.length / 64), packet.encoded_response.length * 4, "JSON decoding");
  const decoded: unknown = JSON.parse(packet.encoded_response);
  meter.retain(decoded, "decoded response retention");
  return decoded;
}

function admitPacket(packet: RetainedConsumerPacket, raw: unknown, row: PacketReadout, meter: RetainedConsumerLedger) {
  meter.phase = "page_admission";
  meter.retain(packet.query_semantics, "query admission copy");
  const query = admitSourceSemanticQuery(packet.query_semantics, packet.original_query);
  if (query.kind !== "admitted") throw new Error(`query admission ${query.kind}`);
  const inputCount = query.query.alternatives.reduce((sum, alternative) => sum + (alternative.evidence_inputs?.length ?? 0), 0);
  if (query.query.alternatives.length > 2 || inputCount > 7 || query.query.evaluation !== undefined
    || query.query.alternatives.some(alternative => (alternative.evidence_inputs?.length ?? 0) === 0)) {
    throw new Error("query exceeds the finite evidence-alternative readout contract");
  }
  // Precharge the public parse, search/exposure copy and unchanged whole-page admission copies.
  for (let copy = 0; copy < 4; copy++) meter.retain(raw, "whole response admission copy");
  const response = SoulInterpretationRecallDeliverySchema.parse(raw);
  if (response.request_budget === undefined) throw new Error("retained response request budget is absent");
  if (response.page_purpose !== "membership" || response.index.page_purpose !== "membership") {
    throw new Error("offline reader accepts retained initial membership packets only");
  }
  const exposure = recordSourceSemanticLibraryFirstExposure(response, undefined, null);
  row.offline_reader_exposure = exposure;
  meter.retain(exposure, "new offline reader exposure");
  const delivery = admitSourceSemanticLibraryResponse({ recallResult: response, firstExposurePage: exposure,
    requestBudget: response.request_budget });
  if (delivery?.status !== "admitted") throw new Error(`whole-page admission ${delivery?.reason ?? "absent"}`);
  if (response.query_semantics_status.status !== "admitted" || response.query_semantics_status.query_semantics_id !== query.query_id) {
    throw new Error("delivered query identity differs from the independent input query");
  }
  row.query_semantics_id = query.query_id; row.delivery_id = response.delivery_id;
  row.native_qualifiers = response.slot_qualifiers;
  row.native_proof_qualifications = delivery.proofs.map(proof => ({ conditional_computation_id: proof.conditional_computation_id,
    semantic_status: proof.semantic_status, conclusion_scope: proof.conclusion_scope, world_claim: proof.world_claim }));
  return { response, delivery, query: query.query, queryId: query.query_id, inputCount };
}
type AdmittedPacket = ReturnType<typeof admitPacket>;

function verifyPacket(packet: RetainedConsumerPacket, admitted: AdmittedPacket,
  row: PacketReadout, meter: RetainedConsumerLedger): SourceSemanticBindingResult[] {
  const { response, delivery, queryId } = admitted, bindings: SourceSemanticBindingResult[] = [];
  for (const qualifier of delivery.qualifiers) {
    const entry = delivery.index.entries[qualifier.index]!;
    meter.phase = "source_binding";
    if (entry.target.kind !== "source_evidence") throw new Error("delivered root is not source evidence");
    const trusted = bindDeliveredSource(packet.sources, entry.target, response.results[qualifier.index]!.content_preview, meter);
    if (qualifier.evidence_kind !== "semantic_proof") continue;
    const selected = proofForLibraryQualifier(entry, qualifier, delivery.proofs);
    if (selected === undefined || selected.original_query !== packet.original_query || selected.query_semantics_id !== queryId
      || canonicalJson(selected.query) !== canonicalJson(admitted.query)) throw new Error("delivered proof has a foreign query binding");
    verifySourceSemanticLocations(trusted.body, selected.interpretation, fieldContractSha256, meter);
    meter.phase = "proof_verification";
    const attempt: ProofAttempt = { slot: qualifier.index, conditional_computation_id: selected.conditional_computation_id!,
      allowance: meter.allowance(), resource_usage: null, status: "pending" };
    meter.retain(attempt, "proof verification attempt"); row.proof_attempts.push(attempt);
    attempt.allowance = meter.allowance();
    if (attempt.allowance.work_units === 0 || attempt.allowance.memory_bytes === 0) {
      throw new SourceSemanticResourceExhausted("proof verification");
    }
    const checked = deliveredSourceSemanticLibraryProof(delivery.index, entry, qualifier, delivery.proofs, trusted.record,
      { ...delivery.budget, ...attempt.allowance,
        finalization_reserve: Math.min(delivery.budget.finalization_reserve, attempt.allowance.work_units) });
    if (![checked.resource_usage.work_units, checked.resource_usage.memory_bytes].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error("proof verification cost is unknown");
    }
    attempt.resource_usage = checked.resource_usage;
    meter.charge(checked.resource_usage.work_units, checked.resource_usage.memory_bytes, "fresh proof verification");
    attempt.status = checked.proof === undefined ? "unverified" : "verified";
    if (checked.proof === undefined) throw new Error("required delivered proof is unverified");
    meter.phase = "support_projection";
    for (const binding of checked.proof.binding_results ?? []) {
      meter.retain(binding, "verified delivered binding");
      bindings.push(binding);
      if (binding.kind !== "evidence") continue;
      const citation: Citation = { alternative: binding.alternative, input: binding.input,
        delivery_id: response.delivery_id, slot: qualifier.index, target: entry.target,
        conditional_computation_id: checked.proof.conditional_computation_id!, binding_id: binding.binding_id,
        explanation_ids: binding.explanation_ids, delivered_text: response.results[qualifier.index]!.content_preview };
      meter.retain(citation, "delivered evidence citation"); row.citations.push(citation);
    }
  }
  return bindings;
}

function bindDeliveredSource(sources: readonly TrustedConsumerSource[], target: SourceEvidenceTarget,
  preview: string, meter: RetainedConsumerLedger): TrustedConsumerSource {
  meter.charge(sources.length + 1, 64, "independent source lookup");
  const matches = sources.filter(source => source.record.workspace_id === target.workspace_id && source.record.identity === target.root_id);
  if (matches.length !== 1 || target.root_kind !== "source_record") throw new Error("missing or ambiguous independent source record");
  const trusted = matches[0]!;
  meter.retain(trusted, "independent source binding");
  meter.charge(Math.ceil(trusted.body.length / 64), trusted.body.length * 4, "source hash and UTF-8 window");
  const record = verifySourceRecordIdentity(SourceRecordIdentitySchema.parse(trusted.record), fieldContractSha256);
  if (hashContentDigest(trusted.body, fieldContractSha256) !== record.content_digest
    || target.source_version !== record.source_version || target.content_digest !== record.content_digest
    || target.evidence_object_id !== record.evidence_object_id) throw new Error("independent source body or target binding differs");
  const span = target.span;
  if (span !== undefined && span.retained_extent !== "body") throw new Error("consumer requires a delivered original-body window");
  const text = span === undefined ? trusted.body : sliceUtf8Span(trusted.body,
    { start_offset: span.content_start, end_offset: span.content_end, purpose: "native_structure" });
  if (text !== preview) throw new Error("delivered text differs from the independently bound source window");
  return { record, body: trusted.body };
}

function conditionalEvidence(query: SourceSemanticQuery, queryId: string, row: PacketReadout,
  premise: EvaluatorCompatibilityPremise, meter: RetainedConsumerLedger): ConditionalReadout {
  if (premise.query_semantics_id !== queryId || premise.id.length === 0
    || !["compatible", "unknown", "incompatible"].includes(premise.compatibility)) throw new Error("external compatibility premise is unbound");
  const node = (alternative: number, input: number) => `input:${alternative}:${input}`;
  const required = query.alternatives.map((alternative, index) => alternative.evidence_inputs!.map((_input, input) => node(index, input)));
  const alternatives = required.map((_inputs, index) => `alternative:${index}`), inputs = required.flat();
  const seeds = new Map((row.support?.evidence_inputs ?? []).filter(input => input.status === "supported")
    .map(input => [node(input.alternative, input.input), 1]));
  if (premise.compatibility === "compatible") seeds.set("external-premise", 1);
  // The consumer declares all inputs necessary within each alternative; AND/OR evaluation remains graph-owned.
  const graph = { nodeIds: [...inputs, ...alternatives, "external-premise", "complete"], seeds, bottom: 0 as const, top: 1,
    edges: [...required.map((from, index) => ({ kind: "and" as const, from: ["external-premise", ...from],
      to: alternatives[index]!, strength: 1 })), { kind: "or" as const, from: alternatives, to: "complete", strength: 1 }] };
  meter.retain({ ...graph, seeds: [...seeds] }, "consumer finite graph");
  const incidence = inputs.length + required.length * 2;
  meter.charge((graph.nodeIds.length + 1) * (incidence + graph.edges.length + 1) * 4,
    (graph.nodeIds.length + incidence) * 256, "single-grade Boolean closure bound");
  const values = evaluateBooleanHypergraph(graph);
  const complete = alternatives.flatMap((alternative, index) => values.has(alternative) ? [index] : []);
  const result = { premise, complete_alternatives: complete, conditional_evidence_complete: values.has("complete"),
    citations: row.citations.filter(citation => complete.includes(citation.alternative)) };
  meter.retain(result, "conditional evidence readout");
  return result;
}
