import type {
  FieldContractSha256,
  ProjectionPin,
  QueryCondition
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import type { QueryConditionDraft } from
  "../../../recall/query/condition/query-condition-capture.js";
import type {
  ActivationEdge,
  ActivationGraph,
  ActivationNode
} from "../../../recall/flood/activation/activation-graph.js";

export const CLOCK_AS_OF = "2026-08-16T00:00:00.000Z";
export const EXPLICIT_AS_OF = "2026-08-15T12:00:00.000Z";
export const GENERATION_ID = `sha256:${"a".repeat(64)}`;
export const OTHER_GENERATION_ID = `sha256:${"b".repeat(64)}`;

export function testSha256(): FieldContractSha256 {
  return fieldContractSha256;
}

export function frozenClock(asOf = CLOCK_AS_OF): () => string {
  return () => asOf;
}

export function countingClock(asOf = CLOCK_AS_OF): {
  readonly now: () => string;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    now: () => {
      calls += 1;
      return asOf;
    },
    calls: () => calls
  };
}

export function testPin(overrides: Partial<ProjectionPin> = {}): ProjectionPin {
  return {
    workspace_id: "workspace-1",
    generation_id: GENERATION_ID,
    pinned_at: CLOCK_AS_OF,
    ...overrides
  };
}

export function conditionDraft(
  overrides: Partial<QueryConditionDraft> = {}
): QueryConditionDraft {
  return {
    principal: "agent",
    workspace_id: "workspace-1",
    authorized_scopes: ["workspace-1", "project-a"],
    explicit_bridges: ["bridge-adopt"],
    workspace_project: "project-a",
    query_task_factors: ["task:ada"],
    governance_state: "open",
    activation_budget: 8,
    token_budget: 400,
    ...overrides
  };
}

export function completeCondition(
  overrides: Partial<QueryCondition> = {}
): QueryCondition {
  return {
    ...conditionDraft(),
    effective_as_of: CLOCK_AS_OF,
    ...overrides
  };
}

export function node(
  candidateKey: string,
  overrides: Partial<ActivationNode> = {}
): ActivationNode {
  return {
    candidate_key: candidateKey,
    workspace_id: "workspace-1",
    principal: "agent",
    scope: "workspace-1",
    generation_id: GENERATION_ID,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    adopted_bridge: null,
    sealed: false,
    erased: false,
    revoked: false,
    authorized_anchor: false,
    task_factor_id: null,
    ...overrides
  };
}

export function edge(
  from: string,
  to: string,
  overrides: Partial<ActivationEdge> = {}
): ActivationEdge {
  return {
    from,
    to,
    channel: "path",
    lambda: 0.5,
    hop_cost: 0.05,
    source: `${from}->${to}`,
    generation_id: GENERATION_ID,
    ...overrides
  };
}

export function graph(
  nodes: readonly ActivationNode[],
  edges: readonly ActivationEdge[],
  rhoByChannel: Readonly<Record<string, number>> = { path: 0.8, seed: 0.8 }
): ActivationGraph {
  return { nodes, edges, rho_by_channel: rhoByChannel };
}
