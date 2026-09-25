import { canonicalProductIdentity, productEndpointId, type SourceSemanticAttention,
  type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { ObservationPairs } from "../conditional-field/engine/observation-frontier.js";
import type { admitSourceSemanticCorrespondence } from "../conditional-field/query/source-semantic-correspondence-admission.js";
import type { SourceSemanticExecutionPlan } from "../conditional-field/query/compile-source-semantic-finite.js";
import type { SourceSemanticLoweredObligation } from "../conditional-field/query/compile-source-semantic-query.js";

type Admission = Extract<ReturnType<typeof admitSourceSemanticCorrespondence>, { kind: "admitted" }>;
type ComputedAttention = Extract<SourceSemanticAttention, { kind: "computed" }>;
type Entry = ComputedAttention["entries"][number];

type Scope = NonNullable<Entry["scope"]>;
type Emit = (status: Entry["state"], observation: Entry["observation"], scope: Scope) => void;

/** Pair completion is local to a reached product; it cannot close a sibling binding. */
function obligationState(obligation: SourceSemanticLoweredObligation, state: FieldEngineState,
  pairs: ObservationPairs, meter: SourceSemanticResourceLedger, emit: Emit): void {
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
    for (const advance of advances) {
      meter.charge(1, 0, "semantic attention product advance");
      if (advance.relation === relation && advance.from === live.program_state) advancesHere = true;
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
    for (const row of state.observed_relations ?? []) {
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
    for (const transition of state.transitions) {
      meter.charge(1, 0, "semantic attention admitted transition");
      if (transition.relation_kind === obligation.relation_kind &&
          canonicalProductIdentity(transition.from) === fromId) transitionAccepted = true;
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
      });
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
