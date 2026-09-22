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
// Retained H request identities bind these exact bytes. Only query semantics and semantic correspondence envelopes use
// the corrected instruction; historical source artifacts remain replayable.
const SOURCE_SCHEMA_INSTRUCTION =
  "Return JSON satisfying this complete local response schema. All required fields, kinds and operands remain mandatory; omitted or invalid expressions will be rejected. Return the complete source interpretation, not the schema itself.\n";

/** Provider decoding guidance is weaker than local admission, which keeps every required field. */
export function projectGeminiGenerationSchema(schema: object): { schema?: object; recursive: boolean; instruction?: string } {
  const root = schema as Schema, recursiveReferences = new Map<string, boolean>();
  const contract = record(record(root.properties)?.contract);
  const values = Array.isArray(contract?.enum) ? contract.enum : [contract?.const];
  const envelope = values.some(value => typeof value === "string"
    && /^source-semantic-(query|alignment)-response-v[23]$/u.test(value));
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
  if (cycle(root)) return { recursive: true, instruction: instruction + JSON.stringify(schema) };
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

export function countGeminiEnvelopeExpandedNodes(schema: object): number {
  return expandedEnvelopeNodes(schema as Schema);
}

/** Compact shared definitions can still expand exponentially at the provider.
 * This guard applies to query semantics and semantic correspondence envelopes; retained source interpretation decoding identities stay fixed. */
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
