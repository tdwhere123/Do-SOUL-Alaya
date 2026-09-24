import { z } from "zod";
import { SOURCE_SEMANTIC_MAX_BYTES } from "../../garden/source-semantic-draft.js";
import {
  SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH,
  SourceSemanticQueryCarrierBodySchema,
  SourceSemanticQueryMeaningBodySchema, type QueryMeaning, type SourceSemanticQueryMeaningBody
} from "./semantic-query-meaning.js";

type CarrierNode = Record<string, unknown> & { node: string; kind: string };
type CarrierBody = Omit<SourceSemanticQueryMeaningBody, "alternatives"> & {
  alternatives: readonly { conditions: readonly string[];
    evidence_inputs?: readonly { conditions: readonly string[] }[]; purpose?: "support" | "counterexample" }[];
  nodes: readonly CarrierNode[];
};

// A serialized table may be larger than the semantic graph, but the shared byte
// bound still limits its actual size before schema parsing or expansion.
function fail(message: string): never {
  throw new z.ZodError([{ code: "custom", path: [], message }]);
}

function references(node: CarrierNode): readonly string[] {
  if (node.kind === "statement" || node.kind === "not" || node.kind === "possible" || node.kind === "reported") {
    return node.content === undefined ? [] : [node.content as string];
  }
  if (node.kind === "conditional") return [node.antecedent as string, node.consequent as string];
  if (node.kind === "opaque") return node.operands as string[];
  return [];
}

/** Decode only supplied structure. The existing meaning parser and compiler own all semantics. */
export function expandSourceSemanticQueryCarrier(value: unknown, limits?: Readonly<{
  work_units?: number; memory_bytes?: number
}>): SourceSemanticQueryMeaningBody {
  const maxWork = Math.min(SOURCE_SEMANTIC_MAX_BYTES, limits?.work_units ?? SOURCE_SEMANTIC_MAX_BYTES);
  const maxBytes = Math.min(SOURCE_SEMANTIC_MAX_BYTES, limits?.memory_bytes ?? SOURCE_SEMANTIC_MAX_BYTES);
  const raw = JSON.stringify(value);
  if (raw === undefined || Buffer.byteLength(raw, "utf8") > SOURCE_SEMANTIC_MAX_BYTES * 4 ||
      limits?.memory_bytes !== undefined && Buffer.byteLength(raw, "utf8") > limits.memory_bytes) {
    fail("query carrier exceeds its byte bound");
  }
  const body = SourceSemanticQueryCarrierBodySchema.parse(value) as CarrierBody;
  const table = new Map<string, CarrierNode>();
  for (const node of body.nodes) {
    if (table.has(node.node)) fail(`duplicate serialization reference: ${node.node}`);
    table.set(node.node, node);
  }
  const state = new Map<string, "active" | "done">();
  const order: string[] = [];
  const roots = body.alternatives.flatMap(alternative => [
    ...alternative.conditions,
    ...(alternative.evidence_inputs ?? []).flatMap(input => input.conditions)
  ]);
  for (const root of roots) {
    if (state.get(root) === "done") continue;
    const stack = [{ token: root, next: 0 }];
    while (stack.length > 0) {
      const current = stack[stack.length - 1]!;
      const node = table.get(current.token);
      if (node === undefined) fail(`missing serialization reference: ${current.token}`);
      if (state.get(current.token) === undefined) state.set(current.token, "active");
      const children = references(node);
      if (current.next === children.length) {
        state.set(current.token, "done");
        order.push(current.token);
        stack.pop();
        continue;
      }
      const child = children[current.next++]!;
      if (!table.has(child)) fail(`missing serialization reference: ${child}`);
      if (state.get(child) === "active") fail(`cyclic serialization reference: ${child}`);
      if (state.get(child) !== "done") stack.push({ token: child, next: 0 });
    }
  }
  if (state.size !== table.size) fail("unreachable serialization reference");
  const statistics = new Map<string, { count: number; bytes: number; depth: number }>();
  for (const token of order) {
    const node = table.get(token)!;
    const { node: _token, ...expression } = node;
    let count = 1;
    let bytes = Buffer.byteLength(JSON.stringify(expression), "utf8");
    let depth = node.kind === "occurrence" ? 0 : 1;
    for (const child of references(node)) {
      const measured = statistics.get(child)!;
      count += measured.count;
      bytes += measured.bytes - Buffer.byteLength(JSON.stringify(child), "utf8");
      depth = Math.max(depth, (node.kind === "occurrence" ? 0 : 1) + measured.depth);
      if (count > maxWork || bytes > maxBytes) {
        fail("query carrier expanded work exceeds its bound");
      }
    }
    if (depth > SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH + 1) fail("query carrier nesting exceeds its bound");
    statistics.set(token, { count, bytes, depth });
  }
  let expandedCount = 0;
  let expandedBytes = Buffer.byteLength(JSON.stringify({ ...body, nodes: undefined }), "utf8");
  for (const token of roots) {
    const measured = statistics.get(token)!;
    expandedCount += measured.count;
    expandedBytes += measured.bytes - Buffer.byteLength(JSON.stringify(token), "utf8");
    if (expandedCount > maxWork || expandedBytes > maxBytes) {
      fail("query carrier expanded work exceeds its bound");
    }
  }
  if (expandedBytes > maxBytes) fail("query carrier expanded work exceeds its bound");

  const expand = (token: string): QueryMeaning => {
    const { node: _token, ...expression } = table.get(token)!;
    const result: Record<string, unknown> = { ...expression };
    for (const field of ["content", "antecedent", "consequent"] as const) {
      if (typeof result[field] === "string") result[field] = expand(result[field]);
    }
    if (Array.isArray(result.operands)) result.operands = result.operands.map(child => expand(child as string));
    return result as QueryMeaning;
  };
  const { nodes: _nodes, ...meaning } = body;
  return SourceSemanticQueryMeaningBodySchema.parse({ ...meaning,
    alternatives: body.alternatives.map(alternative => ({ ...alternative,
      conditions: alternative.conditions.map(expand),
      ...(alternative.evidence_inputs === undefined ? {} : {
        evidence_inputs: alternative.evidence_inputs.map(input => ({ conditions: input.conditions.map(expand) }))
      })
    }))
  });
}

/** Deterministic authoring path for neutral examples and exact round-trip controls. */
export function encodeSourceSemanticQueryCarrier(value: SourceSemanticQueryMeaningBody): z.infer<typeof SourceSemanticQueryCarrierBodySchema> {
  const body = SourceSemanticQueryMeaningBodySchema.parse(value);
  const nodes: CarrierNode[] = [];
  const put = (expression: QueryMeaning): string => {
    const node = `n${nodes.length + 1}`;
    const row: Record<string, unknown> = { ...expression, node };
    nodes.push(row as CarrierNode);
    for (const field of ["content", "antecedent", "consequent"] as const) {
      if (row[field] !== undefined) row[field] = put(row[field] as QueryMeaning);
    }
    if (Array.isArray(row.operands)) row.operands = row.operands.map(child => put(child as QueryMeaning));
    return node;
  };
  const encoded = { ...body,
    alternatives: body.alternatives.map(alternative => ({ ...alternative,
      conditions: alternative.conditions.map(put),
      ...(alternative.evidence_inputs === undefined ? {} : {
        evidence_inputs: alternative.evidence_inputs.map(input => ({ conditions: input.conditions.map(put) }))
      })
    })), nodes
  };
  return SourceSemanticQueryCarrierBodySchema.parse(encoded);
}
