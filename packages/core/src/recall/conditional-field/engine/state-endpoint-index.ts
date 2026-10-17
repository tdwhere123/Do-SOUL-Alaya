import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { productEndpointId, type ProductStateKey } from "@do-soul/alaya-protocol";
import { RetainedSequence, type RetainedRows } from "./retained-sequence.js";
import type { FieldEngineState } from "./field-engine.js";
import type { PendingPathEffects } from "./path-effect-cursor.js";

/** The identity owner appends each admitted state once, preserving its input order. */
export type StateEndpointIndex = Readonly<{
  rows: RetainedRows<ProductStateKey>;
  endpoints: PersistentStringMap<RetainedSequence<ProductStateKey>>;
}>;

/** Raw/epsilon fields never use this index; existing unindexed populations keep the scan. */
export function indexedIdentityWork(state: Pick<FieldEngineState,
  "compiled_automaton" | "identity_index" | "state_endpoint_index">): number {
  return state.state_endpoint_index !== undefined || (state.compiled_automaton !== undefined
    && state.compiled_automaton.hyperedgeAdvances.length === 0 && (state.identity_index?.size ?? 0) === 0) ? 2 : 1;
}

export function endpointIndexEntryBytes(index: StateEndpointIndex, state: ProductStateKey): number {
  const endpoint = productEndpointId(state);
  // The first state pays the index header and settled-context reference slots.
  return (index.rows.length === 0 ? 128 : 0) + (index.endpoints.has(endpoint) ? 16 : 112 + 2 * endpoint.length);
}

export function appendEndpointState(index: StateEndpointIndex, state: ProductStateKey,
  rows: RetainedRows<ProductStateKey>): StateEndpointIndex {
  const endpoint = productEndpointId(state);
  const bucket = index.endpoints.get(endpoint) ?? RetainedSequence.empty<ProductStateKey>();
  return { rows, endpoints: index.endpoints.with(endpoint, bucket.append(state)) };
}

/** Only a completed unchanged population proves its old state demands already registered. */
export function settledEndpointIndex(state: FieldEngineState, pending: PendingPathEffects): StateEndpointIndex | undefined {
  const options = pending.input.options, index = state.state_endpoint_index, frontier = state.path_effect_frontier;
  const context = frontier?.demand_context;
  if (index === undefined || index.rows !== options.liveStates || options.joinRows === undefined
    || (options.liveStateOffset ?? 0) !== 0 || frontier?.identities !== index.rows.length
    || frontier.discoveries !== (options.discoveries?.length ?? 0)
    || frontier.facets !== options.facets || context === undefined
    || context.interpretation !== options.interpretation || context.overlay !== options.overlay
    || context.physicalKinds !== options.physicalKinds
    || options.compiledAutomaton === undefined || options.compiledAutomaton.hyperedgeAdvances.length !== 0
    || (frontier.sourceFacts !== options.sourceFacts && pending.population_checked !== true)) return undefined;
  return index;
}
