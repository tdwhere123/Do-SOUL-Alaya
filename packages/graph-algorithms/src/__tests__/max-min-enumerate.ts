import type { MaxMinInput } from "../max-min-field.js";

export function enumerateMaxMinField(input: MaxMinInput): ReadonlyMap<string, number> {
  const nodeIds = [...new Set(input.nodeIds)];
  const values = new Map<string, number>();
  for (const nodeId of nodeIds) {
    values.set(nodeId, clampInteger(input.seeds.get(nodeId) ?? input.bottom, input.bottom, input.top));
  }
  const edges = new Map<string, Array<{ to: string; strength: number }>>();
  for (const transition of input.transitions) {
    if (!values.has(transition.from) || !values.has(transition.to)) continue;
    const strength = clampInteger(transition.strength, input.bottom, input.top);
    const outgoing = edges.get(transition.from);
    if (outgoing === undefined) edges.set(transition.from, [{ to: transition.to, strength }]);
    else outgoing.push({ to: transition.to, strength });
  }
  for (const nodeId of nodeIds) {
    const seed = values.get(nodeId) ?? input.bottom;
    if (seed > input.bottom) visit(nodeId, seed, new Set([nodeId]), values, edges);
  }
  return values;
}

function visit(
  nodeId: string,
  strength: number,
  seen: ReadonlySet<string>,
  values: Map<string, number>,
  edges: ReadonlyMap<string, readonly { to: string; strength: number }[]>
): void {
  values.set(nodeId, Math.max(values.get(nodeId) ?? 0, strength));
  for (const edge of edges.get(nodeId) ?? []) {
    if (seen.has(edge.to)) continue;
    visit(edge.to, Math.min(strength, edge.strength), new Set(seen).add(edge.to), values, edges);
  }
}

function clampInteger(value: number, bottom: number, top: number): number {
  if (!Number.isFinite(value)) return bottom;
  const integer = Math.trunc(value);
  if (integer < bottom) return bottom;
  if (integer > top) return top;
  return integer;
}
