import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import type { Derivation, SeedActivation, Transition } from "@do-soul/alaya-protocol";
import { productStateNodeId } from "../reference/bind-max-min.js";
import { ruleIdentity, transitionKey } from "./path-composition.js";
import type { FieldEngineState } from "./field-engine.js";
import { RetainedSequence, type RetainedRows } from "./retained-sequence.js";

export type FieldRetentionIndex = Readonly<{
  rows: Pick<FieldEngineState, "observations" | "measurements" | "seeds" | "guaranteed_seeds" | "transitions"
    | "guaranteed_transitions" | "derivations" | "facets" | "discoveries">;
  payloads: PersistentStringMap<true>;
  observations: PersistentStringMap<number>;
  measurements: PersistentStringMap<true>;
  seeds: PersistentStringMap<number>;
  guaranteedSeeds: PersistentStringMap<number>;
  transitions: PersistentStringMap<true>;
  ruleRevisions: PersistentStringMap<string>;
  derivations: PersistentStringMap<Derivation>;
  facets: PersistentStringMap<true>;
  discoveries: PersistentStringMap<true>;
}>;

export function indexFieldRetention(state: Pick<FieldEngineState, "observations" | "measurements" | "seeds" | "guaranteed_seeds"
  | "transitions" | "guaranteed_transitions" | "derivations" | "facets" | "discoveries">): FieldRetentionIndex {
  let payloads = new PersistentStringMap<true>();
  for (const rows of [state.observations, state.measurements, state.seeds, state.transitions, state.derivations, state.facets, state.discoveries]) {
    for (const row of rows) payloads = payloads.with(JSON.stringify(row), true);
  }
  let observations = new PersistentStringMap<number>();
  state.observations.forEach((row, index) => { observations = observations.with(row.observation_id, index); });
  let measurements = new PersistentStringMap<true>();
  for (const row of state.measurements) measurements = measurements.with(row.observation_id, true);
  let transitions = new PersistentStringMap<true>();
  let ruleRevisions = new PersistentStringMap<string>();
  for (const row of state.transitions) {
    transitions = transitions.with(transitionKey(row), true);
    if (row.revision_id !== undefined) ruleRevisions = ruleRevisions.with(ruleIdentity(row), row.revision_id);
  }
  let derivations = new PersistentStringMap<Derivation>();
  for (const row of state.derivations) derivations = derivations.with(row.derivation_id, row);
  let facets = new PersistentStringMap<true>();
  for (const row of state.facets) facets = facets.with(row.path_id, true);
  let discoveries = new PersistentStringMap<true>();
  for (const row of state.discoveries) discoveries = discoveries.with(row.assertion_id, true);
  return { rows: { observations: RetainedSequence.from(state.observations), measurements: RetainedSequence.from(state.measurements),
    seeds: RetainedSequence.from(state.seeds), guaranteed_seeds: RetainedSequence.from(state.guaranteed_seeds),
    transitions: RetainedSequence.from(state.transitions), guaranteed_transitions: RetainedSequence.from(state.guaranteed_transitions),
    derivations: RetainedSequence.from(state.derivations), facets: RetainedSequence.from(state.facets), discoveries: RetainedSequence.from(state.discoveries) },
    payloads, observations, measurements, transitions, ruleRevisions, derivations, facets, discoveries,
    seeds: seedOffsets(state.seeds), guaranteedSeeds: seedOffsets(state.guaranteed_seeds) };
}

function seedOffsets(seeds: RetainedRows<SeedActivation>): PersistentStringMap<number> {
  let offsets = new PersistentStringMap<number>();
  seeds.forEach((row, index) => { offsets = offsets.with(productStateNodeId(row.state), index); });
  return offsets;
}

export function mergeSeedAdditions(prior: RetainedRows<SeedActivation>, incoming: readonly SeedActivation[],
  offsets: PersistentStringMap<number>): Readonly<{ rows: RetainedRows<SeedActivation>; additions: readonly SeedActivation[]; offsets: PersistentStringMap<number> }> {
  if (incoming.length === 0) return { rows: prior, additions: [], offsets };
  let rows = RetainedSequence.from(prior);
  const additions: SeedActivation[] = [];
  for (const seed of incoming) {
    const key = productStateNodeId(seed.state);
    const offset = offsets.get(key);
    if (offset !== undefined && rows.at(offset)!.milligrades >= seed.milligrades) continue;
    if (offset === undefined) { offsets = offsets.with(key, rows.length); rows = rows.append(seed); }
    else rows = rows.replace(offset, seed);
    additions.push(seed);
  }
  return { rows, additions, offsets };
}

export function newTransitionAdditions(incoming: readonly Transition[], index: FieldRetentionIndex): Readonly<{
  additions: readonly Transition[]; keys: PersistentStringMap<true>; revisions: PersistentStringMap<string>; reset: boolean;
}> {
  let keys = index.transitions;
  let revisions = index.ruleRevisions;
  let reset = false;
  const additions: Transition[] = [];
  for (const row of incoming) {
    const key = transitionKey(row);
    if (keys.has(key)) continue;
    keys = keys.with(key, true);
    if (row.instance_id !== undefined && row.revision_id !== undefined) {
      const identity = ruleIdentity(row);
      const previous = revisions.get(identity);
      reset ||= previous !== undefined && previous !== row.revision_id;
      revisions = revisions.with(identity, row.revision_id);
    }
    additions.push(row);
  }
  return { additions, keys, revisions, reset };
}
