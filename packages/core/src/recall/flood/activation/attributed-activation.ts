import {
  verifyQueryConditionReceipt,
  type AttributedActivationPort,
  type AttributedActivationReceipt,
  type FieldContractSha256,
  type QueryCondition,
  type QueryConditionReceipt
} from "@do-soul/alaya-protocol";
import {
  evaluateHardMask,
  seedActivationEnergy,
  type HardMaskInput
} from "../../query/condition/hard-soft-masks.js";
import type {
  ActivationEdge,
  ActivationGraph,
  ActivationNode,
  ActivationSlicePort,
  ActivationWritePort
} from "./activation-graph.js";
import { freezeSeeds, openCandidate, sortedKeys } from "./activation-membership.js";
import { activationDisposition } from "./activation-stop.js";
import {
  channelsOf,
  outgoingEdges,
  prepareTransfers,
  type PreparedTransfer
} from "./activation-transfer.js";

export type AttributedActivationPath = Readonly<{
  readonly channel: string;
  readonly source: string;
  readonly edge: string;
  readonly hop: number;
  readonly from: string;
  readonly to: string;
  readonly energy: number;
}>;

export type AttributedActivationBudget = Readonly<{
  readonly allocated: number;
  readonly consumed: number;
  readonly remaining: number;
}>;

export type AttributedActivationTrace = Readonly<{
  readonly receipt: AttributedActivationReceipt;
  readonly effective_as_of: string;
  readonly paths: readonly AttributedActivationPath[];
  readonly budget: AttributedActivationBudget;
  readonly write_back_count: 0;
}>;

export type AttributedActivationDeps = Readonly<{
  readonly sha256: FieldContractSha256;
  readonly graph: ActivationGraph;
  readonly slice?: ActivationSlicePort;
  readonly write?: ActivationWritePort;
}>;

type ExpansionState = {
  opened: ReadonlySet<string>;
  energy: Map<string, Map<string, number>>;
  hops: Map<string, number>;
  queue: string[];
  queued: Set<string>;
  budgetRemaining: number;
  paths: AttributedActivationPath[];
  unprocessedTransferable: boolean;
};

export function createAttributedActivationPort(
  deps: AttributedActivationDeps
): AttributedActivationPort {
  return {
    attribute: (input) => runAttributedActivation(input, deps).receipt
  };
}

export function runAttributedActivation(
  input: QueryConditionReceipt,
  deps: AttributedActivationDeps
): AttributedActivationTrace {
  const receipt = verifyQueryConditionReceipt(input, deps.sha256);
  // Snapshot so a write-back into the caller's graph cannot mint seeds after start.
  const frozen = { ...deps, graph: snapshotGraph(deps.graph) };
  const authorized = authorizeGraph(frozen.graph, hardMaskFrom(receipt));
  const seeds = freezeSeeds(authorized, receipt.condition);
  const state = createState(
    seeds,
    authorized,
    receipt.condition.effective_as_of,
    receipt.condition.activation_budget
  );
  expandField(state, authorized, receipt.condition, frozen);
  return toTrace(receipt, seeds, state);
}

function snapshotGraph(graph: ActivationGraph): ActivationGraph {
  return {
    nodes: Object.freeze([...graph.nodes]),
    edges: Object.freeze([...graph.edges]),
    rho_by_channel: graph.rho_by_channel
  };
}

function hardMaskFrom(receipt: QueryConditionReceipt): HardMaskInput {
  return {
    workspace_id: receipt.condition.workspace_id,
    authorized_scopes: receipt.condition.authorized_scopes,
    explicit_bridges: receipt.condition.explicit_bridges,
    generation_id: receipt.generation_id,
    effective_as_of: receipt.condition.effective_as_of
  };
}

function authorizeGraph(
  graph: ActivationGraph,
  mask: HardMaskInput
): ReadonlyMap<string, ActivationNode> {
  const authorized = new Map<string, ActivationNode>();
  for (const node of graph.nodes) {
    if (evaluateHardMask(node, mask) === "allow") {
      authorized.set(node.candidate_key, node);
    }
  }
  return authorized;
}

function createState(
  seeds: readonly string[],
  authorized: ReadonlyMap<string, ActivationNode>,
  asOf: string,
  budget: number
): ExpansionState {
  const energy = new Map<string, Map<string, number>>();
  const hops = new Map<string, number>();
  for (const seedId of seeds) {
    const seed = authorized.get(seedId);
    if (seed === undefined) continue;
    energy.set(seedId, new Map([["seed", seedActivationEnergy(seed, asOf)]]));
    hops.set(seedId, 0);
  }
  return {
    opened: new Set(seeds),
    energy,
    hops,
    queue: [...seeds],
    queued: new Set(seeds),
    budgetRemaining: budget,
    paths: [],
    unprocessedTransferable: false
  };
}

function expandField(
  state: ExpansionState,
  authorized: ReadonlyMap<string, ActivationNode>,
  condition: QueryCondition,
  deps: AttributedActivationDeps
): void {
  while (state.queue.length > 0) {
    if (state.budgetRemaining === 0) {
      state.unprocessedTransferable = hasTransferableWork(state, authorized, condition, deps);
      return;
    }
    const nodeId = state.queue.shift();
    if (nodeId === undefined) return;
    state.queued.delete(nodeId);
    expandFromNode(nodeId, state, authorized, condition, deps);
  }
}

function expandFromNode(
  nodeId: string,
  state: ExpansionState,
  authorized: ReadonlyMap<string, ActivationNode>,
  condition: QueryCondition,
  deps: AttributedActivationDeps
): void {
  const source = authorized.get(nodeId);
  if (source === undefined) return;
  const outgoing = outgoingEdges(nodeId, deps.graph, authorized);
  for (const channel of channelsOf(outgoing)) {
    transferChannel(
      source,
      channel,
      outgoing.filter((edge) => edge.channel === channel),
      state,
      authorized,
      condition,
      deps
    );
    if (state.budgetRemaining === 0 && state.unprocessedTransferable) return;
  }
}

function transferChannel(
  source: ActivationNode,
  channel: string,
  edges: readonly ActivationEdge[],
  state: ExpansionState,
  authorized: ReadonlyMap<string, ActivationNode>,
  condition: QueryCondition,
  deps: AttributedActivationDeps
): void {
  const prepared = prepareTransfers({
    source,
    available: readEnergy(state, source.candidate_key, channel),
    edges,
    authorized,
    graph: deps.graph,
    condition,
    slice: deps.slice
  });
  for (const transfer of prepared) {
    if (state.budgetRemaining === 0) {
      state.unprocessedTransferable = true;
      return;
    }
    state.budgetRemaining -= 1;
    applyTransfer(source, channel, transfer, state);
  }
}

function applyTransfer(
  source: ActivationNode,
  channel: string,
  transfer: PreparedTransfer,
  state: ExpansionState
): void {
  const hop = (state.hops.get(source.candidate_key) ?? 0) + 1;
  state.paths.push({
    channel,
    source: transfer.edge.source,
    edge: `${transfer.edge.from}->${transfer.edge.to}:${channel}`,
    hop,
    from: transfer.edge.from,
    to: transfer.edge.to,
    energy: transfer.energy
  });
  const previous = readEnergy(state, transfer.edge.to, channel);
  writeEnergy(state, transfer.edge.to, channel, Math.max(previous, transfer.energy));
  const nextHop = state.hops.get(transfer.edge.to);
  if (nextHop === undefined || hop < nextHop) state.hops.set(transfer.edge.to, hop);
  state.opened = openCandidate(state.opened, transfer.edge.to);
  if (transfer.energy > previous && !state.queued.has(transfer.edge.to)) {
    state.queue.push(transfer.edge.to);
    state.queued.add(transfer.edge.to);
  }
}

function hasTransferableWork(
  state: ExpansionState,
  authorized: ReadonlyMap<string, ActivationNode>,
  condition: QueryCondition,
  deps: AttributedActivationDeps
): boolean {
  for (const nodeId of new Set([...state.queue, ...state.opened])) {
    const source = authorized.get(nodeId);
    if (source === undefined) continue;
    if (nodeHasTransfer(source, state, authorized, condition, deps)) return true;
  }
  return false;
}

function nodeHasTransfer(
  source: ActivationNode,
  state: ExpansionState,
  authorized: ReadonlyMap<string, ActivationNode>,
  condition: QueryCondition,
  deps: AttributedActivationDeps
): boolean {
  const outgoing = outgoingEdges(source.candidate_key, deps.graph, authorized);
  for (const channel of channelsOf(outgoing)) {
    const prepared = prepareTransfers({
      source,
      available: readEnergy(state, source.candidate_key, channel),
      edges: outgoing.filter((edge) => edge.channel === channel),
      authorized,
      graph: deps.graph,
      condition,
      slice: deps.slice
    });
    if (prepared.length > 0) return true;
  }
  return false;
}

function readEnergy(state: ExpansionState, nodeId: string, channel: string): number {
  const channels = state.energy.get(nodeId);
  return channels?.get(channel) ?? channels?.get("seed") ?? 0;
}

function writeEnergy(
  state: ExpansionState,
  nodeId: string,
  channel: string,
  value: number
): void {
  const current = state.energy.get(nodeId) ?? new Map<string, number>();
  current.set(channel, value);
  state.energy.set(nodeId, current);
}

function toTrace(
  input: QueryConditionReceipt,
  seeds: readonly string[],
  state: ExpansionState
): AttributedActivationTrace {
  const stop = activationDisposition({
    budgetRemaining: state.budgetRemaining,
    unprocessedTransferable: state.unprocessedTransferable
  });
  return Object.freeze({
    receipt: Object.freeze({
      workspace_id: input.condition.workspace_id,
      generation_id: input.generation_id,
      condition_digest: input.identity,
      seed_ids: seeds,
      opened_candidate_keys: sortedKeys(state.opened),
      stop_disposition: stop.stop_disposition,
      frontier: stop.frontier
    }),
    effective_as_of: input.condition.effective_as_of,
    paths: Object.freeze([...state.paths]),
    budget: Object.freeze({
      allocated: input.condition.activation_budget,
      consumed: input.condition.activation_budget - state.budgetRemaining,
      remaining: state.budgetRemaining
    }),
    write_back_count: 0
  });
}
