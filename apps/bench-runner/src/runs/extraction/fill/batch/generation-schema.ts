import { SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT } from "@do-soul/alaya-soul";
import { SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT } from "@do-soul/alaya-protocol";

type Schema = Record<string, unknown>;
const mapPositions = ["properties", "patternProperties", "dependentSchemas"];
const listPositions = ["allOf", "anyOf", "oneOf", "prefixItems"];
const singlePositions = ["items", "additionalProperties", "contains", "not", "if", "then", "else",
  "propertyNames", "unevaluatedProperties", "unevaluatedItems"];

/** A 19KiB query schema exceeded provider flattening limits. This conservative
 * wire budget is not a guarantee about provider complexity; local admission
 * always retains the full schema, including when decoding uses JSON mode. */
const GEMINI_STRUCTURED_SCHEMA_MAX_BYTES = 16 * 1024;
const GEMINI_ENVELOPE_EXPANSION_MAX_NODES = 1024;

const ENVELOPE_SCHEMA_INSTRUCTION =
  "Return JSON satisfying this complete local response schema. All required fields, kinds and operands remain mandatory; omitted or invalid expressions will be rejected. Return the complete response envelope including its contract, outcome and body, not the schema itself.\n";
// Retained source interpretation request identities bind these exact bytes.
const SOURCE_SCHEMA_INSTRUCTION =
  "Return JSON satisfying this complete local response schema. All required fields, kinds and operands remain mandatory; omitted or invalid expressions will be rejected. Return the complete source interpretation, not the schema itself.\n";

/** Provider decoding guidance is weaker than local admission, which keeps every required field. */
export function projectGeminiGenerationSchema(schema: object): { schema?: object; recursive: boolean; instruction?: string } {
  const root = schema as Schema, recursiveReferences = new Map<string, boolean>();
  const contract = record(record(root.properties)?.contract);
  const values = Array.isArray(contract?.enum) ? contract.enum : [contract?.const];
  const envelope = values.some(value => value === SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT
    || value === SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT);
  const instruction = envelope ? ENVELOPE_SCHEMA_INSTRUCTION : SOURCE_SCHEMA_INSTRUCTION;
  const cycle = (value: unknown, visiting = new Set<string>()): boolean => {
    const node = record(value); if (node === undefined) return false;
    if (typeof node.$ref === "string") {
      const reference = node.$ref;
      if (visiting.has(reference)) return true;
      const cached = recursiveReferences.get(reference);
      if (cached !== undefined) return cached;
      const target = resolveReference(root, reference);
      const next = new Set(visiting); next.add(reference);
      const result = cycle(target, next);
      recursiveReferences.set(reference, result);
      return result;
    }
    return schemaChildren(node).some(child => cycle(child, visiting));
  };
  if (cycle(root)) {
    const current = values.some(value => value === SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT
      || value === SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT);
    const projected = current ? projectRecursiveStructure(root) : undefined;
    const guidance = instruction + JSON.stringify(schema);
    if (projected === undefined || Buffer.byteLength(JSON.stringify(projected)) > GEMINI_STRUCTURED_SCHEMA_MAX_BYTES
      || expandedEnvelopeNodes(projected) > GEMINI_ENVELOPE_EXPANSION_MAX_NODES) {
      return { recursive: true, instruction: guidance };
    }
    return { schema: projected, recursive: true, instruction: guidance };
  }
  const visit = (value: unknown): unknown => {
    const node = record(value); if (node === undefined) return value;
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "maxItems").map(([key, child]) => {
      if (key === "additionalProperties" && record(child) !== undefined && Object.keys(child as Schema).length === 0) return [key, true];
      if ([...mapPositions, "$defs", "definitions"].includes(key) && record(child) !== undefined) {
        return [key, Object.fromEntries(Object.entries(child as Schema).map(([name, entry]) => [name, visit(entry)]))];
      }
      if (listPositions.includes(key) && Array.isArray(child)) return [key, child.map(visit)];
      if (singlePositions.includes(key)) return [key, visit(child)];
      return [key, structuredClone(child)];
    }));
  };
  const projected = visit(root) as object;
  if (Buffer.byteLength(JSON.stringify(projected)) > GEMINI_STRUCTURED_SCHEMA_MAX_BYTES
    || envelope && expandedEnvelopeNodes(root) > GEMINI_ENVELOPE_EXPANSION_MAX_NODES) {
    return { recursive: false, instruction: instruction + JSON.stringify(schema) };
  }
  return { schema: projected, recursive: false };
}

/** The first recursive back edge accepts the target's JSON types, not a truncated semantic grammar.
 * Required fields above that edge remain useful decoding constraints; full local admission and
 * complete-schema guidance still own deeper structure, references and semantic refinements. */
function projectRecursiveStructure(root: Schema): Schema | undefined {
  const graph = new Map<string, readonly string[]>();
  let supported = true, visited = 0;
  const references = (value: unknown): string[] => {
    const node = record(value); if (node === undefined) return [];
    // Weakening a negated/conditional schema can narrow its accepted language.
    if (["not", "if", "then", "else", "$dynamicRef", "$recursiveRef"].some(key => key in node)) supported = false;
    if (typeof node.$ref === "string") {
      // The historical expansion counter resolves a ref alone. Scalar sibling bounds are safe;
      // sibling sub-schemas would need a different accounting contract, so retain JSON mode.
      if (schemaChildren(node).length > 0) supported = false;
      return [...new Set([node.$ref, ...schemaChildren(node).flatMap(references)])];
    }
    return [...new Set(schemaChildren(node).flatMap(references))];
  };
  const pending = new Set(references(root));
  for (const reference of pending) {
    const edges = references(resolveReference(root, reference));
    graph.set(reference, edges);
    for (const edge of edges) pending.add(edge);
  }
  if (!supported) return undefined;
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false;
    const next = new Set(seen); next.add(from);
    return graph.get(from)!.some(reference => reference === target || reaches(reference, target, next));
  };
  const cyclic = [...pending].filter(reference => reaches(reference, reference));
  const contextual = new Set([...pending].filter(reference => cyclic.some(cycle =>
    reference === cycle || reaches(reference, cycle))));
  const definitions: Schema = {}, memo = new Map<string, string>();
  const visit = (value: unknown, active = new Set<string>()): unknown => {
    const node = record(value); if (node === undefined) return value;
    // Bound projection work too: a finite graph can have exponentially many cycle contexts.
    if (++visited > GEMINI_ENVELOPE_EXPANSION_MAX_NODES) { supported = false; return {}; }
    if (typeof node.$ref === "string") {
      const { $ref: reference, ...siblings } = node;
      // Draft-2020-12 reference siblings also constrain the value (e.g. query evidence minItems).
      const siblingConstraints = visit(siblings, active) as Schema;
      if (active.has(reference)) {
        const constraint = recursiveTypeConstraint(root, resolveReference(root, reference));
        if (constraint === undefined) supported = false;
        return { ...constraint, ...siblingConstraints };
      }
      const context = contextual.has(reference) ? [...active].sort() : [];
      const key = JSON.stringify([reference, context]);
      let name = memo.get(key);
      if (name === undefined) {
        name = `structure${memo.size}`; memo.set(key, name);
        const next = new Set(active); if (cyclic.includes(reference)) next.add(reference);
        definitions[name] = visit(resolveReference(root, reference), next);
      }
      return { $ref: `#/$defs/${name}`, ...siblingConstraints };
    }
    return Object.fromEntries(Object.entries(node)
      .filter(([key]) => !["$defs", "definitions", "$schema", "readOnly", "maxItems"].includes(key))
      .map(([key, child]) => {
        if (key === "additionalProperties" && record(child) !== undefined && Object.keys(child as Schema).length === 0) return [key, true];
        if (mapPositions.includes(key) && record(child) !== undefined) {
          return [key, Object.fromEntries(Object.entries(child as Schema).map(([name, entry]) => [name, visit(entry, active)]))];
        }
        if (listPositions.includes(key) && Array.isArray(child)) {
          // Widened branches may overlap; exclusivity would reject valid deep expressions.
          return [key === "oneOf" ? "anyOf" : key, child.map(entry => visit(entry, active))];
        }
        return [key, singlePositions.includes(key) ? visit(child, active) : structuredClone(child)];
      }));
  };
  const projected = visit(root) as Schema;
  if (!supported) return undefined;
  return Object.keys(definitions).length === 0 ? projected : { ...projected, $defs: definitions };
}

function recursiveTypeConstraint(root: Schema, value: unknown): Schema | undefined {
  const types = (value: unknown, seen = new Set<string>()): string[] | undefined => {
    const node = record(value); if (node === undefined) return undefined;
    if (typeof node.$ref === "string") {
      if (seen.has(node.$ref)) return undefined;
      const next = new Set(seen); next.add(node.$ref);
      return types(resolveReference(root, node.$ref), next);
    }
    if (typeof node.type === "string") return [node.type];
    if (Array.isArray(node.type) && node.type.every(type => typeof type === "string")) return node.type;
    const branches = node.anyOf ?? node.oneOf;
    if (!Array.isArray(branches) || branches.length === 0) return undefined;
    const alternatives = branches.map(branch => types(branch, seen));
    return alternatives.some(branch => branch === undefined) ? undefined : [...new Set(alternatives.flat() as string[])];
  };
  const allowed = types(value);
  return allowed === undefined ? undefined : allowed.length === 1 ? { type: allowed[0] }
    : { anyOf: allowed.map(type => ({ type })) };
}

export function countGeminiEnvelopeExpandedNodes(schema: object): number {
  return expandedEnvelopeNodes(schema as Schema);
}

/** Compact shared definitions can still expand exponentially at the provider.
 * New recursive Source/Query projections and existing Query/Correspondence envelopes use this
 * guard; historical acyclic Source decoding and instruction-only identities stay unchanged. */
function expandedEnvelopeNodes(root: Schema): number {
  const memo = new Map<string, number>();
  const count = (value: unknown): number => {
    const node = record(value);
    if (node === undefined) return 0;
    if (typeof node.$ref === "string") {
      const cached = memo.get(node.$ref);
      if (cached !== undefined) return cached;
      const size = count(resolveReference(root, node.$ref));
      memo.set(node.$ref, size);
      return size;
    }
    let size = 1;
    for (const child of schemaChildren(node)) {
      size += count(child);
      if (size > GEMINI_ENVELOPE_EXPANSION_MAX_NODES) return GEMINI_ENVELOPE_EXPANSION_MAX_NODES + 1;
    }
    return size;
  };
  return count(root);
}

/** Preserve all historical acyclic identities; new recursive requests bind actual decoding guidance. */
export function geminiGenerationSchemaCacheMaterial(preimage: string): string {
  const schema: unknown = JSON.parse(preimage);
  if (record(schema) === undefined) return preimage;
  const projected = projectGeminiGenerationSchema(schema as object);
  if (projected.recursive && projected.schema !== undefined) {
    return JSON.stringify({
      contract: "gemini-structural-generation-schema-v1",
      source_schema: schema, response_schema: projected.schema, instruction: projected.instruction
    });
  }
  if (projected.recursive) {
    return JSON.stringify({
      contract: "gemini-recursive-generation-schema-v3",
      source_schema: schema, response_schema: null, instruction: projected.instruction
    });
  }
  if (projected.schema === undefined && projected.instruction !== undefined) {
    return JSON.stringify({
      contract: "gemini-instruction-generation-schema-v1",
      source_schema: schema, response_schema: null, instruction: projected.instruction
    });
  }
  return preimage;
}

function record(value: unknown): Schema | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Schema : undefined;
}

function schemaChildren(node: Schema): unknown[] {
  const children: unknown[] = [];
  for (const key of mapPositions) { const map = record(node[key]); if (map !== undefined) children.push(...Object.values(map)); }
  for (const key of listPositions) if (Array.isArray(node[key])) children.push(...node[key]);
  for (const key of singlePositions) if (node[key] !== undefined) children.push(node[key]);
  return children;
}

function resolveReference(root: Schema, reference: string): unknown {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) throw new Error("Gemini generation schema requires local JSON-pointer references");
  let value: unknown = root;
  for (const part of reference.slice(2).split("/")) {
    value = record(value)?.[part.replace(/~1/gu, "/").replace(/~0/gu, "~")];
    if (value === undefined) throw new Error("Gemini generation schema has an unresolved reference");
  }
  return value;
}
