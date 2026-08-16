import { compareCodeUnits, type QueryCondition } from "@do-soul/alaya-protocol";
import type { ActivationNode } from "./activation-graph.js";

export function freezeSeeds(
  authorized: ReadonlyMap<string, ActivationNode>,
  condition: QueryCondition
): readonly string[] {
  const seeds: string[] = [];
  for (const node of authorized.values()) {
    if (isInitialSeed(node, condition)) seeds.push(node.candidate_key);
  }
  return Object.freeze(sortedKeys(seeds));
}

export function openCandidate(
  opened: ReadonlySet<string>,
  candidateKey: string
): ReadonlySet<string> {
  if (opened.has(candidateKey)) return opened;
  const next = new Set(opened);
  next.add(candidateKey);
  return next;
}

export function sortedKeys(keys: Iterable<string>): readonly string[] {
  return Object.freeze([...keys].sort(compareText));
}

function isInitialSeed(
  node: ActivationNode,
  condition: QueryCondition
): boolean {
  if (node.authorized_anchor) return true;
  return node.task_factor_id !== null &&
    condition.query_task_factors.includes(node.task_factor_id);
}

function compareText(left: string, right: string): number {
  return compareCodeUnits(left, right);
}
