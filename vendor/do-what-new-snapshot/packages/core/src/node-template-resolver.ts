import {
  FROZEN_NODE_TEMPLATE_CONTRACTS,
  type NodeTemplateContract,
  type NodeTemplateKind,
  type ToolCategory
} from "@do-what/protocol";
import { CoreError } from "./errors.js";

export class NodeTemplateResolver {
  public resolve(kind: NodeTemplateKind): Readonly<NodeTemplateContract> {
    const contract = FROZEN_NODE_TEMPLATE_CONTRACTS.find((candidate) => candidate.node_template === kind);

    if (contract === undefined) {
      throw new CoreError("NOT_FOUND", `Unknown node template kind: ${kind}`);
    }

    return contract;
  }

  public validateBudget(
    kind: NodeTemplateKind,
    proposedToolCalls: number,
    proposedDelegations: number
  ): void {
    const contract = this.resolve(kind);

    if (!Number.isInteger(proposedToolCalls) || proposedToolCalls < 0) {
      throw new CoreError("VALIDATION", `Tool calls ${proposedToolCalls} must be a non-negative integer`);
    }

    if (!Number.isInteger(proposedDelegations) || proposedDelegations < 0) {
      throw new CoreError(
        "VALIDATION",
        `Delegations ${proposedDelegations} must be a non-negative integer`
      );
    }

    if (proposedToolCalls > contract.budget.max_tool_calls) {
      throw new CoreError(
        "VALIDATION",
        `Tool calls ${proposedToolCalls} exceeds ${kind} template max (${contract.budget.max_tool_calls})`
      );
    }

    if (proposedDelegations > contract.budget.max_worker_delegations) {
      throw new CoreError(
        "VALIDATION",
        `Delegations ${proposedDelegations} exceeds ${kind} template max (${contract.budget.max_worker_delegations})`
      );
    }
  }

  public validateToolCategories(
    kind: NodeTemplateKind,
    requestedCategories: readonly ToolCategory[]
  ): void {
    const contract = this.resolve(kind);
    const allowed = new Set<string>(contract.tools);
    const disallowed = requestedCategories.filter((category) => !allowed.has(category));

    if (disallowed.length > 0) {
      throw new CoreError(
        "VALIDATION",
        `Tool categories [${disallowed.join(", ")}] not allowed by ${kind} template`
      );
    }
  }
}
