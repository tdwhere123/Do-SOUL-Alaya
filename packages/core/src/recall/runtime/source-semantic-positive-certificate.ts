import {
  AlayaError, canonicalJson, interpretationNodeIdentity, productEndpointId, SourceSemanticResourceExhausted,
  SourceSemanticResourceLedger, SourceSemanticInterpretationSchema, SourceSemanticPublishedInterpretationSchema,
  SOURCE_SEMANTIC_K_VERSION, type ProductStateKey, type QueryProgram, type RequestBudget, type SourceEvidenceTarget,
  type SourceSemanticReasoningResult
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { BindingContextResourceError, BindingContextStore, parseBindingContext, type BoundSourceFacts } from "../conditional-field/engine/binding-environment.js";
import { advanceProducts, relationTransition, settleLocalComputation } from "../conditional-field/engine/local-advance.js";
import { admitRelationRow, inactiveResolution, relationMatches, type AdjacencyRow } from "../conditional-field/engine/path-matching.js";
import { runtimeProgram, seedActivationsForObservation } from "../conditional-field/engine/path-composition-seed.js";
import {
  ACCEPTING_PROGRAM_STATE, compileProgramAutomaton, programAutomatonCost, ProgramAutomatonResourceError,
  type AutomatonAdvance, type ProgramAutomaton
} from "../conditional-field/engine/program-automaton.js";
import { productStateNodeId } from "../conditional-field/reference/bind-max-min.js";
import { buildTypedObservation, interpretationRowEligible, relationRowEligible } from "../conditional-field/observers/observation-admission.js";
import type { ObserveConditionalFieldInput, RelationObserverRow } from "../conditional-field/observers/observe-ports.js";
import { compileConditionalFieldQuery } from "../conditional-field/query/compile-query.js";
import { defaultView } from "../conditional-field/query/query-admission.js";
import { admitSourceSemanticCorrespondence } from "../conditional-field/query/source-semantic-correspondence-admission.js";
import { lowerSourceSemanticPhases, type SourceSemanticExecutionPlan, type SourceSemanticGroupPhase } from "../conditional-field/query/compile-source-semantic-finite.js";
import { planSourceSemanticBranches } from "./source-semantic-branch-plan.js";
import { compileSourceSemanticPremises, type SourceSemanticPremisePopulation } from "./source-semantic-premises.js";

export type SourceSemanticPositiveCertificateStatus = "verified" | "rejected" | "unsupported" | "exhausted";
export type SourceSemanticPositiveCertificateStep = Readonly<{
  phase: number; earlier: number | null; seed: number; assertion_id: string;
  source_object_id: string; target_object_id: string; predicate: string;
  milligrades: number; bindings: Readonly<Record<string, string>>;
}>;
export type SourceSemanticPositiveCertificateTable = Readonly<{
  seeds: readonly string[];
  steps: readonly SourceSemanticPositiveCertificateStep[];
}>;
export type SourceSemanticPositiveCertificate = Readonly<{
  status: SourceSemanticPositiveCertificateStatus;
  resource_usage: Readonly<{ work_units: number; memory_bytes: number }>;
  certificate?: SourceSemanticPositiveCertificateTable;
}>;
export type SourceSemanticPositiveCertificateInput = Readonly<{
  source_interpretation: unknown;
  query_semantics?: unknown;
  semantic_correspondence?: unknown;
  original_query: string;
  workspaceId: string; scope: string; authorizedScopes: readonly string[] | null; asOf: string;
  sourceValidity?: Readonly<{ valid_from: string | null; valid_to: string | null }>;
  source_target?: SourceEvidenceTarget;
  claimed?: Pick<SourceSemanticReasoningResult, "binding_results">;
  budget?: RequestBudget;
  certificate?: SourceSemanticPositiveCertificateTable;
}>;

type AdvanceYield = Readonly<{ kind: "work"; retained_bytes?: number }>
  | Readonly<{ kind: "effect"; effect: Readonly<{
    unresolved_guard?: boolean; missing_measurement?: boolean; missing_target_revision?: boolean;
    relation_demand?: unknown; source_fact_demand?: unknown;
  }> }>;
type PreparedCertificate = Readonly<{
  admission: Extract<ReturnType<typeof admitSourceSemanticCorrespondence>, { kind: "admitted" }>;
  population: SourceSemanticPremisePopulation;
  execution: SourceSemanticExecutionPlan;
  sourceTarget: SourceEvidenceTarget;
  original: string;
  seedIds: readonly string[];
}>;
type PhaseRuntime = Readonly<{
  automaton: ProgramAutomaton; query: ReturnType<typeof compileConditionalFieldQuery>;
  bindingContexts: BindingContextStore; sourceFacts: ReadonlyMap<string, BoundSourceFacts>;
  observeInput: ObserveConditionalFieldInput;
}>;
type RecordedParent = Readonly<{
  fromId: string; assertion_id: string; source_object_id: string; target_object_id: string;
  predicate: string; milligrades: number; bindings: Readonly<Record<string, string>>;
}>;
type RecordedWalk = Readonly<{
  phase: number; accepting: ReadonlyMap<string, string>; states: ReadonlyMap<string, ProductStateKey>;
  parents: ReadonlyMap<string, RecordedParent>; seeds: ReadonlySet<string>;
}>;

/** Matches the reasoning default so this checker does not import the execution owner. */
const DEFAULT_BUDGET = { schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 };

/** Relation+sequence comparison only. Never writes verified_proofs or mutates evaluation/completeness. */
export function checkSourceSemanticPositiveCertificate(
  input: SourceSemanticPositiveCertificateInput,
  options?: Readonly<{ extra_adjacency?: readonly RelationObserverRow[] }>
): SourceSemanticPositiveCertificate {
  const budget = input.budget ?? DEFAULT_BUDGET;
  const meter = new SourceSemanticResourceLedger(budget);
  try {
    const prepared = prepareCertificate(input, meter);
    if (prepared === "rejected" || prepared === "unsupported") return finishCertificate(prepared, meter);
    if (options?.extra_adjacency !== undefined && options.extra_adjacency.length > 0) {
      attachExtraAdjacency(prepared.population, options.extra_adjacency);
    }
    if (input.certificate !== undefined) {
      return finishCertificate(verifyCertificateTable(input.certificate, prepared, input, budget, meter),
        meter, input.certificate);
    }
    const claimed = claimedFingerprints(input.claimed?.binding_results, meter);
    const walks: RecordedWalk[] = [];
    const reconstructed = new Set<string>();
    for (const [phase, phaseDef] of (prepared.execution.groupPhases ?? []).entries()) {
      const walk = replayRelationSequencePhase(phase, phaseDef, prepared, input, budget, meter);
      if (walk === "unsupported" || walk === "exhausted") return finishCertificate(walk, meter);
      walks.push(walk);
      for (const fingerprint of walk.accepting.values()) reconstructed.add(fingerprint);
    }
    meter.charge(claimed.size + reconstructed.size, 0, "positive certificate comparison");
    const status = claimed.size === reconstructed.size && [...claimed].every((row) => reconstructed.has(row))
      ? "verified" : "rejected";
    return finishCertificate(status, meter, tableFromRecorded(walks, claimed));
  } catch (error) {
    if (error instanceof SourceSemanticResourceExhausted || error instanceof ProgramAutomatonResourceError
      || error instanceof BindingContextResourceError) return finishCertificate("exhausted", meter);
    if (error instanceof AlayaError) return finishCertificate("rejected", meter);
    throw error;
  }
}

function finishCertificate(
  status: SourceSemanticPositiveCertificateStatus, meter: SourceSemanticResourceLedger,
  certificate?: SourceSemanticPositiveCertificateTable
): SourceSemanticPositiveCertificate {
  return {
    status, resource_usage: { work_units: meter.spentWork, memory_bytes: meter.spentBytes },
    ...(certificate === undefined || status === "unsupported" || status === "exhausted" ? {} : { certificate })
  };
}

function prepareCertificate(
  input: SourceSemanticPositiveCertificateInput, meter: SourceSemanticResourceLedger
): PreparedCertificate | "rejected" | "unsupported" {
  meter.retain(input.source_interpretation, "positive certificate interpretation");
  if (input.query_semantics !== undefined) meter.retain(input.query_semantics, "positive certificate query");
  if (input.semantic_correspondence !== undefined) meter.retain(input.semantic_correspondence, "positive certificate correspondence");
  const published = SourceSemanticPublishedInterpretationSchema.safeParse(input.source_interpretation);
  const parsed = published.success ? { success: true as const, data: published.data.interpretation }
    : SourceSemanticInterpretationSchema.safeParse(input.source_interpretation);
  if (!parsed.success || parsed.data.k_version !== SOURCE_SEMANTIC_K_VERSION) return "rejected";
  const admission = admitSourceSemanticCorrespondence({
    semantic_correspondence: input.semantic_correspondence,
    source_interpretation: parsed.data,
    query_semantics: input.query_semantics,
    original_query: input.original_query
  });
  if (admission.kind !== "admitted") return "rejected";
  if (input.authorizedScopes !== null && !input.authorizedScopes.includes(input.scope)) return "rejected";
  if (admission.query.evaluation !== undefined) return "unsupported";
  const sourceTarget = input.source_target ?? (published.success ? published.data.source_target : undefined) ?? {
    kind: "source_evidence" as const, workspace_id: input.workspaceId, root_kind: "source_record" as const,
    root_id: parsed.data.source.source_id, source_version: parsed.data.source.source_version,
    content_digest: parsed.data.source.content_digest, evidence_object_id: null
  };
  if (sourceTarget.workspace_id !== input.workspaceId || sourceTarget.source_version !== parsed.data.source.source_version
    || sourceTarget.content_digest !== parsed.data.source.content_digest) return "rejected";
  const branches = planSourceSemanticBranches(admission.query, admission.semantic_correspondence, meter);
  const population = compileSourceSemanticPremises({
    interpretation: admission.interpretation, semantic_correspondence: admission.semantic_correspondence,
    context_id: admission.context_id, interpretation_id: admission.interpretation_id, scope: input.scope,
    source_target: sourceTarget, meter, sourceValidity: input.sourceValidity, query: admission.query, branches
  });
  const execution = lowerSourceSemanticPhases(admission.query, branches, meter, {
    source_interpretation: admission.interpretation, population, semantic_correspondence: admission.semantic_correspondence
  });
  const phases = execution.groupPhases ?? [];
  if (phases.length === 0) return "unsupported";
  for (const phase of phases) {
    meter.charge(1, 0, "positive certificate fragment");
    if (!relationSequenceProgram(phase.program)) return "unsupported";
  }
  const seedIds: string[] = [];
  for (const id of [...admission.interpretation.entry_roots].sort()) {
    const coordinate = population.coordinates.get(id);
    if (coordinate === undefined) return "rejected";
    seedIds.push(interpretationNodeIdentity(coordinate));
  }
  return { admission, population, execution, sourceTarget, original: input.original_query, seedIds };
}

function relationSequenceProgram(program: QueryProgram): boolean {
  if (program.kind === "relation") return true;
  if (program.kind === "sequence") {
    if (program.steps.length === 0) return false;
    for (const step of program.steps) if (!relationSequenceProgram(step)) return false;
    return true;
  }
  return false;
}

function attachExtraAdjacency(
  population: SourceSemanticPremisePopulation, extras: readonly RelationObserverRow[]
): void {
  const adjacency = population.adjacency as Map<string, RelationObserverRow[]>;
  for (const row of extras) {
    const key = JSON.stringify([row.sourceObjectId, row.predicate]);
    const bucket = adjacency.get(key);
    if (bucket === undefined) adjacency.set(key, [row]);
    else bucket.push(row);
  }
}

function namedPremiseRow(
  population: SourceSemanticPremisePopulation, assertionId: string
): RelationObserverRow | undefined {
  const slash = assertionId.lastIndexOf("/");
  if (slash < 0) return undefined;
  const ordinal = Number(assertionId.slice(slash + 1));
  if (!Number.isInteger(ordinal) || ordinal < 0) return undefined;
  const row = population.rows[ordinal];
  return row?.assertionId === assertionId ? row : undefined;
}

function verifyCertificateTable(
  table: SourceSemanticPositiveCertificateTable, prepared: PreparedCertificate,
  input: SourceSemanticPositiveCertificateInput, budget: RequestBudget, meter: SourceSemanticResourceLedger
): SourceSemanticPositiveCertificateStatus {
  const phases = prepared.execution.groupPhases ?? [];
  for (const [index, step] of table.steps.entries()) {
    if (step.phase < 0 || step.phase >= phases.length) return "rejected";
    if (step.earlier !== null && (step.earlier < 0 || step.earlier >= index
      || table.steps[step.earlier]?.phase !== step.phase)) return "rejected";
    if (table.seeds[step.seed] === undefined) return "rejected";
  }
  const claimed = claimedFingerprints(input.claimed?.binding_results, meter);
  const produced = new Set<string>();
  for (const [phase, phaseDef] of phases.entries()) {
    const steps = table.steps.flatMap((step, index) => step.phase === phase ? [{ step, index }] : []);
    if (steps.length === 0) continue;
    const answers = verifyNamedPhase(phaseDef, steps, table, prepared, input, budget, meter);
    if (answers === "unsupported" || answers === "exhausted" || answers === "rejected") return answers;
    for (const fingerprint of answers) produced.add(fingerprint);
  }
  meter.charge(claimed.size + produced.size, 0, "positive certificate comparison");
  if (claimed.size !== produced.size) return "rejected";
  for (const fingerprint of claimed) if (!produced.has(fingerprint)) return "rejected";
  return "verified";
}

function verifyNamedPhase(
  phase: SourceSemanticGroupPhase, steps: readonly Readonly<{ step: SourceSemanticPositiveCertificateStep; index: number }>[],
  table: SourceSemanticPositiveCertificateTable, prepared: PreparedCertificate,
  input: SourceSemanticPositiveCertificateInput, budget: RequestBudget, meter: SourceSemanticResourceLedger
): Set<string> | SourceSemanticPositiveCertificateStatus {
  const runtime = phaseRuntime(phase, prepared, input, budget, meter);
  if (runtime === "unsupported" || runtime === "exhausted") return runtime;
  const namedSeeds: string[] = [];
  const seenSeeds = new Set<string>();
  for (const { step } of steps) {
    if (step.earlier !== null) continue;
    const objectId = table.seeds[step.seed];
    if (objectId === undefined || !prepared.seedIds.includes(objectId)) return "rejected";
    if (seenSeeds.has(objectId)) continue;
    seenSeeds.add(objectId);
    namedSeeds.push(objectId);
  }
  const live = seedLiveStates(prepared, runtime.observeInput, runtime.query, runtime.automaton,
    runtime.bindingContexts, meter, namedSeeds);
  const seedStates = new Map<string, ProductStateKey[]>();
  for (const state of live) {
    const objectId = productEndpointId(state);
    const bucket = seedStates.get(objectId);
    if (bucket === undefined) seedStates.set(objectId, [state]);
    else bucket.push(state);
  }
  const nodeState = new Map<number, ProductStateKey>();
  const hypothesisId = prepared.admission.context_id;
  for (const { step, index } of steps) {
    meter.charge(1, 64, "positive certificate live state");
    const fromCandidates = step.earlier === null
      ? seedStates.get(table.seeds[step.seed]!) ?? []
      : nodeState.has(step.earlier) ? [nodeState.get(step.earlier)!] : [];
    if (fromCandidates.length === 0) return "rejected";
    const row = namedPremiseRow(prepared.population, step.assertion_id);
    if (row === undefined || row.sourceObjectId !== step.source_object_id
      || row.targetObjectId !== step.target_object_id || row.predicate !== step.predicate) return "rejected";
    if (inactiveResolution(row.resolutionKind) || !relationRowEligible(runtime.observeInput, row)) return "rejected";
    if (row.validity?.kind === "interpretation" && !interpretationRowEligible(row, hypothesisId)) return "rejected";
    const liveStates = [...fromCandidates, ...nodeState.values()];
    let admitted: { to: ProductStateKey; milligrades: number } | undefined;
    for (const from of fromCandidates) {
      const next = admitNamedRow(runtime, from, row, liveStates, meter);
      if (next === undefined) continue;
      admitted = next;
      break;
    }
    if (admitted === undefined || admitted.milligrades !== step.milligrades) return "rejected";
    if (canonicalJson(envBindings(admitted.to, runtime.bindingContexts)) !== canonicalJson(step.bindings)) {
      return "rejected";
    }
    nodeState.set(index, admitted.to);
  }
  const answers = new Set<string>();
  for (const { index } of steps) {
    const state = nodeState.get(index);
    if (state === undefined || state.program_state !== ACCEPTING_PROGRAM_STATE) continue;
    const fingerprint = acceptingFingerprint(state, prepared.execution, runtime.bindingContexts);
    if (fingerprint !== undefined) answers.add(fingerprint);
  }
  return answers;
}

function admitNamedRow(
  runtime: PhaseRuntime, from: ProductStateKey, row: RelationObserverRow,
  liveStates: readonly ProductStateKey[], meter: SourceSemanticResourceLedger
): { to: ProductStateKey; milligrades: number } | undefined {
  for (const advance of runtime.automaton.advancesByState.get(from.program_state) ?? []) {
    if (!relationMatches(advance.relation.relation_kind, row.predicate)) continue;
    const settled = settleLocalComputation(localRelationAdvance(runtime.automaton, advance, row, from, {
      query_id: runtime.query.query_id, overlay: {}, sourceFacts: runtime.sourceFacts,
      bindingContexts: runtime.bindingContexts, liveStates
    }), meter);
    if (settled.kind === "blocked") continue;
    const product = settled.value[0];
    if (product === undefined) continue;
    return { to: product.to, milligrades: product.milligrades };
  }
  return undefined;
}

function replayRelationSequencePhase(
  phaseIndex: number, phase: SourceSemanticGroupPhase, prepared: PreparedCertificate,
  input: SourceSemanticPositiveCertificateInput, budget: RequestBudget, meter: SourceSemanticResourceLedger
): RecordedWalk | "unsupported" | "exhausted" {
  const runtime = phaseRuntime(phase, prepared, input, budget, meter);
  if (runtime === "unsupported" || runtime === "exhausted") return runtime;
  const live = seedLiveStates(prepared, runtime.observeInput, runtime.query, runtime.automaton,
    runtime.bindingContexts, meter);
  const states = new Map<string, ProductStateKey>();
  const seeds = new Set<string>();
  const parents = new Map<string, RecordedParent>();
  const seen = new Set<string>();
  for (const state of live) {
    const id = productStateNodeId(state);
    seen.add(id); states.set(id, state); seeds.add(id);
  }
  const hypothesisId = prepared.admission.context_id;
  for (let index = 0; index < live.length; index += 1) {
    meter.charge(1, 64, "positive certificate live state");
    const from = live[index]!;
    const endpoint = productEndpointId(from);
    for (const advance of runtime.automaton.advancesByState.get(from.program_state) ?? []) {
      const rows = prepared.population.adjacency.get(JSON.stringify([endpoint, advance.relation.relation_kind])) ?? [];
      for (const row of rows) {
        if (inactiveResolution(row.resolutionKind) || !relationRowEligible(runtime.observeInput, row)) continue;
        if (row.validity?.kind === "interpretation" && !interpretationRowEligible(row, hypothesisId)) continue;
        const settled = settleLocalComputation(localRelationAdvance(runtime.automaton, advance, row, from, {
          query_id: runtime.query.query_id, overlay: {}, sourceFacts: runtime.sourceFacts,
          bindingContexts: runtime.bindingContexts, liveStates: live
        }), meter);
        if (settled.kind === "blocked") continue;
        for (const product of settled.value) {
          const id = productStateNodeId(product.to);
          if (seen.has(id)) continue;
          seen.add(id);
          live.push(product.to);
          states.set(id, product.to);
          parents.set(id, {
            fromId: productStateNodeId(from), assertion_id: row.assertionId, source_object_id: row.sourceObjectId,
            target_object_id: row.targetObjectId, predicate: row.predicate, milligrades: product.milligrades,
            bindings: envBindings(product.to, runtime.bindingContexts)
          });
        }
      }
    }
  }
  const accepting = new Map<string, string>();
  for (const [id, state] of states) {
    if (state.program_state !== ACCEPTING_PROGRAM_STATE) continue;
    const fingerprint = acceptingFingerprint(state, prepared.execution, runtime.bindingContexts);
    if (fingerprint !== undefined) accepting.set(id, fingerprint);
  }
  return { phase: phaseIndex, accepting, states, parents, seeds };
}

function tableFromRecorded(
  walks: readonly RecordedWalk[], claimed: ReadonlySet<string>
): SourceSemanticPositiveCertificateTable {
  const seeds: string[] = [];
  const seedIndex = new Map<string, number>();
  const internSeed = (objectId: string): number => {
    const found = seedIndex.get(objectId);
    if (found !== undefined) return found;
    const index = seeds.length;
    seedIndex.set(objectId, index);
    seeds.push(objectId);
    return index;
  };
  const steps: SourceSemanticPositiveCertificateStep[] = [];
  for (const walk of walks) {
    const used = new Set<string>();
    for (const [id, fingerprint] of walk.accepting) {
      if (!claimed.has(fingerprint)) continue;
      let current: string | undefined = id;
      while (current !== undefined && !used.has(current)) {
        used.add(current);
        current = walk.parents.get(current)?.fromId;
      }
    }
    const placed = new Map<string, number>();
    let remaining = true;
    while (remaining) {
      remaining = false;
      for (const id of used) {
        if (placed.has(id)) continue;
        const parent = walk.parents.get(id);
        if (parent === undefined) continue;
        const fromSeed = walk.seeds.has(parent.fromId);
        if (!fromSeed && !placed.has(parent.fromId)) continue;
        const fromState = walk.states.get(parent.fromId);
        if (fromState === undefined) continue;
        placed.set(id, steps.length);
        steps.push({
          phase: walk.phase, earlier: fromSeed ? null : placed.get(parent.fromId)!,
          seed: internSeed(productEndpointId(fromState)), assertion_id: parent.assertion_id,
          source_object_id: parent.source_object_id, target_object_id: parent.target_object_id,
          predicate: parent.predicate, milligrades: parent.milligrades, bindings: parent.bindings
        });
        remaining = true;
      }
    }
  }
  return { seeds, steps };
}

function phaseRuntime(
  phase: SourceSemanticGroupPhase, prepared: PreparedCertificate,
  input: SourceSemanticPositiveCertificateInput, budget: RequestBudget, meter: SourceSemanticResourceLedger
): PhaseRuntime | "unsupported" | "exhausted" {
  const runtime = runtimeProgram(phase.program);
  if (runtime === "empty" || runtime === "epsilon") return "unsupported";
  const cost = programAutomatonCost(phase.program);
  meter.charge(cost.work_units, cost.retained_bytes, "positive certificate automaton");
  const automaton = compileProgramAutomaton(runtime);
  if (automaton.hyperedgeAdvances.length > 0) return "unsupported";
  const remaining = { ...budget, ...meter.remaining() };
  if (remaining.work_units < remaining.finalization_reserve + remaining.min_envelope) return "exhausted";
  const snapshot = `sha256:${fieldContractSha256(canonicalJson({
    conditional_computation_id: prepared.admission.context_id, scopes: input.authorizedScopes, as_of: input.asOf
  }))}`;
  const query = compileConditionalFieldQuery({
    source: "typed", snapshot_id: snapshot, budget: remaining,
    query_id: `sha256:${fieldContractSha256(canonicalJson({
      conditional_computation_id: prepared.admission.context_id, query: prepared.original,
      alternative: phase.alternative, target: phase.plan.target, group: phase.groupFrame ?? ""
    }))}`,
    program: phase.program, interpretation_clock: input.asOf,
    hypotheses: [{ schema_version: 1, hypothesis_id: prepared.admission.context_id, bindings: [] }],
    view: { ...defaultView(), result_kind_view: "mixed", protocol_version: 1, supported_result_kinds: ["source_evidence", "memory_entry"] },
    authorized_scopes: input.authorizedScopes
  });
  const bindingContexts = new BindingContextStore(Math.max(0, remaining.memory_bytes));
  return {
    automaton, query, bindingContexts, sourceFacts: sourceFactsFrom(prepared.population, input.workspaceId),
    observeInput: seedObservationInput(query, input, snapshot)
  };
}

function seedLiveStates(
  prepared: PreparedCertificate, observeInput: ObserveConditionalFieldInput,
  query: ReturnType<typeof compileConditionalFieldQuery>, automaton: ProgramAutomaton,
  bindingContexts: BindingContextStore, meter: SourceSemanticResourceLedger,
  seedIds: readonly string[] = prepared.seedIds
): ProductStateKey[] {
  const live: ProductStateKey[] = [];
  const seen = new Set<string>();
  for (const objectId of seedIds) {
    meter.charge(1, 0, "positive certificate seed");
    const sourceRow = prepared.population.nodes.get(objectId);
    if (sourceRow === undefined) continue;
    const observation = buildTypedObservation(observeInput, {
      objectId, sourceRevision: sourceRow.sourceRevision, observationKey: objectId,
      sourceRow, target: sourceRow.target, identityKind: "object"
    });
    if (observation === null) continue;
    for (const seed of seedActivationsForObservation(observation, query, observeInput.as_of ?? query.interpretation_clock ?? "",
      bindingContexts, automaton)) {
      const id = productStateNodeId(seed.state);
      if (seen.has(id)) continue;
      seen.add(id);
      live.push(seed.state);
    }
  }
  return live;
}

function* localRelationAdvance(
  automaton: ProgramAutomaton, advance: AutomatonAdvance,
  row: RelationObserverRow, from: ProductStateKey,
  input: Readonly<{
    query_id: string; overlay: Record<string, never>; sourceFacts: ReadonlyMap<string, BoundSourceFacts>;
    bindingContexts: BindingContextStore; liveStates: readonly ProductStateKey[];
  }>
): Generator<AdvanceYield, readonly { programState: string; to: ProductStateKey; milligrades: number }[], void> {
  yield { kind: "work", retained_bytes: 64 };
  const inner = admitRelationRow(advance.relation, from, row as AdjacencyRow, input);
  let step = inner.next();
  while (!step.done) {
    const current = step.value;
    if (current.kind === "work") yield { kind: "work", retained_bytes: current.retained_bytes };
    else {
      const effect = current.effect;
      yield { kind: "effect", effect: {
        unresolved_guard: effect.unresolved_guard, missing_measurement: effect.missing_measurement,
        missing_target_revision: effect.missing_target_revision, relation_demand: effect.relation_demand,
        source_fact_demand: effect.source_fact_demand
      } };
    }
    step = inner.next();
  }
  const admitted = step.value;
  if (admitted === undefined) return [];
  const products = advanceProducts(automaton, { to: advance.to }, row as AdjacencyRow, from, {
    binding: admitted.binding, targetRevision: admitted.targetRevision
  }, { bindingContexts: input.bindingContexts, sourceFacts: input.sourceFacts });
  return products.filter((product) => relationTransition(row as AdjacencyRow, from, product.to, admitted.strength) !== undefined)
    .map((product) => ({ ...product, milligrades: admitted.strength.milligrades }));
}

function seedObservationInput(
  query: ReturnType<typeof compileConditionalFieldQuery>,
  input: SourceSemanticPositiveCertificateInput, snapshot: string
): ObserveConditionalFieldInput {
  return {
    query, workspace_id: input.workspaceId, authorized_scopes: input.authorizedScopes, as_of: input.asOf, readers: {},
    lease: { schema_version: 1, lease_id: "lease-1", snapshot_id: snapshot, query_id: query.query_id, status: "active" },
    action: { schema_version: 1, action: "seed", region_id: "seed", work_limit: 20 },
    cursor: {
      schema_version: 1, cursor_id: "seed", snapshot_id: snapshot, query_id: query.query_id, region_id: "seed",
      position: null, committed_through: null
    }
  };
}

function sourceFactsFrom(
  population: SourceSemanticPremisePopulation, workspaceId: string
): Map<string, BoundSourceFacts> {
  const facts = new Map<string, BoundSourceFacts>();
  for (const [objectId, row] of population.nodes) {
    facts.set(objectId, {
      object_id: objectId, workspace_id: workspaceId, source_revision: row.sourceRevision,
      ...(row.interpretation_node === undefined ? {} : { interpretation_node: row.interpretation_node }),
      ...(row.scope_class === undefined ? {} : { scope_class: row.scope_class }),
      ...(row.valid_from === undefined ? {} : { valid_from: row.valid_from }),
      ...(row.valid_to === undefined ? {} : { valid_to: row.valid_to })
    });
  }
  return facts;
}

function envBindings(state: ProductStateKey, bindingContexts: BindingContextStore): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const [variable, value] of parseBindingContext(state.binding_context, bindingContexts)) {
    if (!variable.startsWith("@")) bindings[variable] = value;
  }
  return bindings;
}

function claimedFingerprints(
  rows: SourceSemanticReasoningResult["binding_results"], meter: SourceSemanticResourceLedger
): Set<string> {
  const fingerprints = new Set<string>();
  for (const row of rows ?? []) {
    meter.charge(1, 0, "positive certificate claimed answer");
    const bindings: Record<string, string> = {};
    for (const [variable, coordinate] of Object.entries(row.bindings)) {
      bindings[variable] = interpretationNodeIdentity(coordinate);
    }
    fingerprints.add(canonicalJson({ alternative: row.alternative, bindings }));
  }
  return fingerprints;
}

function acceptingFingerprint(
  state: ProductStateKey, execution: SourceSemanticExecutionPlan, bindingContexts: BindingContextStore
): string | undefined {
  const env = parseBindingContext(state.binding_context, bindingContexts);
  const accepted = [...env.keys()].filter((key) => key.startsWith("@accepted:"));
  if (accepted.length !== 1) return undefined;
  const branchIndex = Number(accepted[0]!.slice("@accepted:".length));
  if (!Number.isInteger(branchIndex) || branchIndex < 0) return undefined;
  const alternative = execution.branches[branchIndex]?.alternative ?? branchIndex;
  const bindings: Record<string, string> = {};
  for (const [variable, value] of env) if (!variable.startsWith("@")) bindings[variable] = value;
  return canonicalJson({ alternative, bindings });
}
