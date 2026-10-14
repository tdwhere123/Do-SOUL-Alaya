import { canonicalProductIdentity, productEndpointId, type SourceSemanticAttention,
  type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { ObservationPairs } from "../conditional-field/engine/observation-frontier.js";
import type { admitSourceSemanticCorrespondence } from "../conditional-field/query/source-semantic-correspondence-admission.js";
import type { SourceSemanticExecutionPlan, SourceSemanticGroupPhase } from "../conditional-field/query/compile-source-semantic-finite.js";
import type { SourceSemanticLoweredObligation } from "../conditional-field/query/compile-source-semantic-query.js";

type Admission = Extract<ReturnType<typeof admitSourceSemanticCorrespondence>, { kind: "admitted" }>;
type ComputedAttention = Extract<SourceSemanticAttention, { kind: "computed" }>;
type Entry = ComputedAttention["entries"][number];

type Scope = NonNullable<Entry["scope"]>;
type Emit = (status: Entry["state"], observation: Entry["observation"], scope: Scope) => void;
type ObservedRelationRow = NonNullable<FieldEngineState["observed_relations"]> extends Iterable<infer Row> ? Row : never;
type AttentionTransition = FieldEngineState["transitions"] extends Iterable<infer Row> ? Row : never;
type AttentionLookups = {
  observedByEndpoint?: Map<string, Map<string, ObservedRelationRow[]>>;
  transitionsByProduct?: Map<string, Map<string, AttentionTransition[]>>;
};

/** Same logical sizes as SourceSemanticResourceLedger.retain. Raw rows are not copied or remeasured. */
const NEW_CONTAINER_BYTES = 64;
const NEW_REFERENCE_BYTES = 8;

function newStringBytes(value: string): number {
  return 24 + 4 * value.length;
}

function allocateCharged<T>(meter: SourceSemanticResourceLedger, phase: string, bytes: number, create: () => T): T {
  meter.charge(0, bytes, phase);
  return create();
}

function rememberReference<T>(meter: SourceSemanticResourceLedger, phase: string, bucket: T[], row: T): void {
  meter.charge(0, NEW_REFERENCE_BYTES, phase);
  bucket.push(row);
}

/** Subject and predicate are separate map keys. A concatenated pair key can collide when either contains U+0000. */
function attentionLookups(state: FieldEngineState, meter: SourceSemanticResourceLedger,
  cache: AttentionLookups): Required<AttentionLookups> {
  if (cache.observedByEndpoint !== undefined && cache.transitionsByProduct !== undefined) {
    return { observedByEndpoint: cache.observedByEndpoint, transitionsByProduct: cache.transitionsByProduct };
  }
  const observedByEndpoint = indexObservedPairs(state, meter);
  const transitionsByProduct = indexAdmittedTransitions(state, meter);
  cache.observedByEndpoint = observedByEndpoint;
  cache.transitionsByProduct = transitionsByProduct;
  return { observedByEndpoint, transitionsByProduct };
}

function indexObservedPairs(state: FieldEngineState, meter: SourceSemanticResourceLedger) {
  const phase = "semantic attention observed pair index";
  meter.charge(1, NEW_CONTAINER_BYTES, phase);
  const observedByEndpoint = new Map<string, Map<string, ObservedRelationRow[]>>();
  for (const row of state.observed_relations ?? []) {
    meter.charge(1, 0, phase);
    let byPredicate = observedByEndpoint.get(row.sourceObjectId);
    if (byPredicate === undefined) {
      byPredicate = allocateCharged(meter, phase, NEW_CONTAINER_BYTES + NEW_REFERENCE_BYTES, () => new Map());
      observedByEndpoint.set(row.sourceObjectId, byPredicate);
    }
    let bucket = byPredicate.get(row.predicate);
    if (bucket === undefined) {
      bucket = allocateCharged(meter, phase, NEW_CONTAINER_BYTES + NEW_REFERENCE_BYTES, () => []);
      byPredicate.set(row.predicate, bucket);
    }
    rememberReference(meter, phase, bucket, row);
  }
  return observedByEndpoint;
}

function indexAdmittedTransitions(state: FieldEngineState, meter: SourceSemanticResourceLedger) {
  const phase = "semantic attention admitted transition index";
  meter.charge(1, NEW_CONTAINER_BYTES, phase);
  const transitionsByProduct = new Map<string, Map<string, AttentionTransition[]>>();
  for (const transition of state.transitions) {
    meter.charge(1, 0, phase);
    const fromId = canonicalProductIdentity(transition.from);
    // Identity allocation belongs to the existing function. Debit that string before the index retains it.
    meter.charge(0, newStringBytes(fromId), phase);
    let byKind = transitionsByProduct.get(fromId);
    if (byKind === undefined) {
      byKind = allocateCharged(meter, phase, NEW_CONTAINER_BYTES + NEW_REFERENCE_BYTES, () => new Map());
      transitionsByProduct.set(fromId, byKind);
    }
    let bucket = byKind.get(transition.relation_kind);
    if (bucket === undefined) {
      bucket = allocateCharged(meter, phase, NEW_CONTAINER_BYTES + NEW_REFERENCE_BYTES, () => []);
      byKind.set(transition.relation_kind, bucket);
    }
    rememberReference(meter, phase, bucket, transition);
  }
  return transitionsByProduct;
}

/** Pair completion is local to a reached product; it cannot close a sibling binding. */
function obligationState(obligation: SourceSemanticLoweredObligation, state: FieldEngineState,
  pairs: ObservationPairs, meter: SourceSemanticResourceLedger, emit: Emit, cache: AttentionLookups): void {
  if (state.closure.observation === "unavailable") { emit("unavailable", "unavailable", { kind: "branch" }); return; }
  if (state.closure.observation === "unknown" || state.closure.observation === "invalidated") {
    emit("unknown", state.closure.observation, { kind: "branch" }); return;
  }
  const advances = state.compiled_automaton?.advances ?? [];
  let relation: (typeof advances)[number]["relation"] | undefined;
  for (const advance of advances) {
    meter.charge(1, 0, "semantic attention automaton provenance");
    if (advance.relation.relation_kind === obligation.relation_kind &&
        advance.relation.source_variable === obligation.source_variable) {
      if (relation !== undefined && relation !== advance.relation) {
        emit("unknown", "unknown", { kind: "branch" }); return;
      }
      relation = advance.relation;
    }
  }
  // Repeated or renamed relations cannot be assigned to this Q occurrence.
  if (relation === undefined) { emit("unobserved", "unknown", { kind: "branch" }); return; }
  let reached = false;
  for (const live of state.seen_identities) {
    meter.charge(1, 0, "semantic attention live product");
    let advancesHere = false;
    meter.charge(1, 0, "semantic attention program state lookup");
    for (const advance of state.compiled_automaton?.advancesByState.get(live.program_state) ?? []) {
      meter.charge(1, 0, "semantic attention product advance");
      if (advance.relation === relation) advancesHere = true;
    }
    if (!advancesHere) continue;
    reached = true;
    meter.charge(1, 256, "semantic attention pair coordinate");
    const subject = productEndpointId(live);
    const scope = { kind: "pair" as const, subject_id: subject, product: live };
    const progress = pairs.status(subject, obligation.relation_kind);
    if (progress !== "complete") {
      emit(progress === "open" && (state.memory_exhausted || state.remaining_work.length > 0)
        ? "resource_incomplete" : "unobserved", progress === "open" ? "open" : "unknown", scope);
      continue;
    }
    let observed = false;
    const lookups = attentionLookups(state, meter, cache);
    meter.charge(1, 0, "semantic attention observed pair lookup");
    const observedRows = lookups.observedByEndpoint.get(subject)?.get(obligation.relation_kind) ?? [];
    for (const row of observedRows) {
      meter.charge(1, 0, "semantic attention observed pair");
      if (row.sourceObjectId === subject && row.predicate === obligation.relation_kind) observed = true;
    }
    if (!observed) {
      emit(obligation.obligation === "predicate" || obligation.obligation === "slot" ||
        obligation.obligation === "referent" ? "correspondence_missing" : "observed_no_match", "exhausted", scope);
      continue;
    }
    meter.charge(1, 512, "semantic attention product identity");
    const fromId = canonicalProductIdentity(live);
    let transitionAccepted = false;
    meter.charge(1, 0, "semantic attention admitted transition lookup");
    const admitted = lookups.transitionsByProduct.get(fromId)?.get(obligation.relation_kind) ?? [];
    for (const transition of admitted) {
      meter.charge(1, 0, "semantic attention admitted transition");
      if (transition.relation_kind === obligation.relation_kind
        && canonicalProductIdentity(transition.from) === fromId) transitionAccepted = true;
    }
    if (!transitionAccepted) emit("unknown", "exhausted", scope);
    // A successful atom can still fail a later binding or join.
  }
  if (!reached) emit("unobserved", "unknown", { kind: "branch" });
}

/** The compiler supplies Q coordinates; the field supplies reached products and exact observation progress. */
export function sourceSemanticBranchAttention(admission: Admission, execution: SourceSemanticExecutionPlan,
  state: FieldEngineState, acceptedBranchIndices: ReadonlySet<number>,
  meter: SourceSemanticResourceLedger): ComputedAttention | undefined {
  const target = admission.interpretation.source;
  const pairs = new ObservationPairs(state.pair_progress, state.pair_completed_count,
    state.pair_revision, state.pair_demands, state.pair_progress_bytes);
  const lookups: AttentionLookups = {};
  const entries: Entry[] = [];
  let truncated = false;
  for (const [branchIndex, branch] of execution.branches.entries()) {
    meter.charge(1, 0, "semantic attention actual branch");
    // Phase execution pads lower acceptance indices; those placeholders are not executed branches.
    if (branch.plan === undefined && branch.obligations === undefined) continue;
    if (entries.length === 64) { truncated = true; break; }
    const phase = branch.plan === undefined ? undefined : {
      accept_index: branch.plan.acceptIndex, group_frame: branch.plan.groupFrame ?? null };
    const beforeBranch = entries.length;
    for (const obligation of branch.obligations ?? []) {
      meter.charge(1, 0, "semantic attention lowered obligation");
      obligationState(obligation, state, pairs, meter, (status, observation, scope) => {
        if (entries.length === 64) { truncated = true; return; }
        meter.charge(1, 512, "semantic attention scoped entry");
        entries.push({ alternative: obligation.alternative, frame: obligation.frame,
          obligation: obligation.obligation, ...(obligation.role === undefined ? {} : { role: obligation.role }),
          ...(obligation.variable === undefined ? {} : { variable: obligation.variable }),
          ...(phase === undefined ? {} : { phase }), state: status, observation, scope });
      }, lookups);
      if (entries.length === 64) { truncated = true; break; }
    }
    if (entries.length === beforeBranch && !acceptedBranchIndices.has(branchIndex)) {
      if (entries.length === 64) { truncated = true; break; }
      meter.charge(1, 256, "semantic attention unproved actual branch");
      entries.push({ alternative: branch.alternative, frame: null, obligation: "branch",
        ...(phase === undefined ? {} : { phase }),
        state: "unknown", observation: "unknown", scope: { kind: "branch" } });
    }
  }
  if (entries.length === 0) return undefined;
  meter.retain(entries, "semantic attention retention");
  return { contract: "source-semantic-attention-v1", kind: "computed", conditional_computation_id: admission.context_id,
    source_interpretation_id: admission.interpretation_id, query_semantics_id: admission.query_id,
    semantic_correspondence_id: admission.semantic_correspondence_id,
    source_id: target.source_id, source_version: target.source_version, content_digest: target.content_digest,
    entries, truncated };
}

export function unexecutedGroupAttention(admission: Admission, phases: readonly SourceSemanticGroupPhase[],
  meter: SourceSemanticResourceLedger): ComputedAttention | undefined {
  if (phases.length === 0) return undefined;
  const entries: Entry[] = [];
  for (const phase of phases) {
    meter.charge(1, 0, "unprojected semantic group inspection");
    if (entries.length === 64) break;
    meter.charge(1, 256, "unprojected semantic group attention");
    entries.push({ alternative: phase.alternative, frame: null, obligation: "branch",
      phase: { accept_index: phase.acceptIndex, group_frame: phase.groupFrame ?? null },
      state: "unknown", observation: "unknown", scope: { kind: "branch" } });
  }
  const source = admission.interpretation.source;
  return { contract: "source-semantic-attention-v1", kind: "computed",
    conditional_computation_id: admission.context_id, source_interpretation_id: admission.interpretation_id,
    query_semantics_id: admission.query_id, semantic_correspondence_id: admission.semantic_correspondence_id,
    source_id: source.source_id, source_version: source.source_version, content_digest: source.content_digest,
    entries, truncated: phases.length > entries.length };
}

export function mergeComputedAttention(parts: readonly (SourceSemanticAttention | undefined)[],
  meter: SourceSemanticResourceLedger, incomplete = false): ComputedAttention | undefined {
  let attentionTemplate: ComputedAttention | undefined;
  const attentionEntries: Entry[] = [];
  let attentionTruncated = incomplete;
  for (const current of parts) {
    meter.charge(1, 0, "merged semantic attention body");
    if (current?.kind !== "computed") continue;
    attentionTemplate ??= current;
    if (current.truncated) attentionTruncated = true;
    for (const entry of current.entries) {
      meter.charge(1, 0, "merged semantic attention entry inspection");
      if (attentionEntries.length === 64) { attentionTruncated = true; break; }
      meter.charge(1, 8, "merged semantic attention retention");
      attentionEntries.push(entry);
    }
  }
  return attentionTemplate === undefined ? undefined : { ...attentionTemplate,
    entries: attentionEntries, truncated: attentionTruncated };
}
