import { ShadowContractError } from "../envelope.js";
import type { SupportHypergraphReceiptV1 } from "./receipt.js";

export type ProvedDistinctBindingsV1 = Readonly<{
  readonly status: "proved_distinct";
  readonly count: number;
}>;

export function provedDistinctBindingCount(
  receipt: SupportHypergraphReceiptV1
): ProvedDistinctBindingsV1 {
  for (const alias of receipt.aliases) {
    if (alias.state === "may_equal" || alias.state === "unknown") {
      throw new ShadowContractError("may_equal alias is not proved distinct");
    }
    if (alias.state === "conflict") {
      throw new ShadowContractError("conflicting alias cannot prove distinctness");
    }
  }
  const equalGroups = new Map<string, string>();
  for (const node of receipt.nodes) {
    if (node.kind === "answer_binding") equalGroups.set(node.id, node.id);
  }
  for (const alias of receipt.aliases) {
    if (alias.state !== "equal") continue;
    union(equalGroups, alias.left_id, alias.right_id);
  }
  const roots = new Set<string>();
  for (const id of equalGroups.keys()) roots.add(find(equalGroups, id));
  return Object.freeze({ status: "proved_distinct" as const, count: roots.size });
}

function union(groups: Map<string, string>, left: string, right: string): void {
  const rootLeft = find(groups, left);
  const rootRight = find(groups, right);
  if (rootLeft !== rootRight) groups.set(rootLeft, rootRight);
}

function find(groups: Map<string, string>, id: string): string {
  const parent = groups.get(id);
  if (parent === undefined) {
    throw new ShadowContractError("alias names a missing answer_binding");
  }
  if (parent === id) return id;
  const root = find(groups, parent);
  groups.set(id, root);
  return root;
}
