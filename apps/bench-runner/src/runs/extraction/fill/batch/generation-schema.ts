type Schema = Record<string, unknown>;
const mapPositions = ["properties", "patternProperties", "dependentSchemas"];
const listPositions = ["allOf", "anyOf", "oneOf", "prefixItems"];
const singlePositions = ["items", "additionalProperties", "contains", "not", "if", "then", "else",
  "propertyNames", "unevaluatedProperties", "unevaluatedItems"];

/** Provider decoding guidance is weaker than local admission, which keeps every required field. */
export function projectGeminiGenerationSchema(schema: object): { schema: object; recursive: boolean; instruction?: string } {
  const root = schema as Schema, recursiveReferences = new Map<string, boolean>();
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
  let recursive = false;
  const visit = (value: unknown): unknown => {
    const node = record(value); if (node === undefined) return value;
    if (typeof node.$ref === "string" && cycle(node)) {
      // Recursive expression structure remains in full source-schema guidance
      // and strict local validation; the provider decoder only requires an object.
      const target = record(resolveReference(root, node.$ref));
      if (target === undefined || !objectAlternatives(target)) throw new Error("Recursive Gemini decoding projection requires object expressions");
      recursive = true;
      return { type: "object", additionalProperties: true };
    }
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "maxItems").map(([key, child]) => {
      if (key === "additionalProperties" && record(child) !== undefined && Object.keys(child as Schema).length === 0) return [key, true];
      if ([...mapPositions, "$defs", "definitions"].includes(key) && record(child) !== undefined) {
        // Keep definition paths addressable: an acyclic ref can point into a
        // non-recursive child of a recursive definition. Its cyclic refs are projected below.
        return [key, Object.fromEntries(Object.entries(child as Schema).map(([name, entry]) => [name, visit(entry)]))];
      }
      if (listPositions.includes(key) && Array.isArray(child)) return [key, child.map(visit)];
      if (singlePositions.includes(key)) return [key, visit(child)];
      return [key, structuredClone(child)];
    }));
  };
  const projected = visit(root) as object;
  return { schema: projected, recursive, ...(recursive ? { instruction:
    "The provider decoding schema constrains the outer envelope only. Every recursive expression must still satisfy this complete local response schema. All required fields, kinds and operands remain mandatory; omitted or invalid expressions will be rejected. Return the complete source interpretation, not the schema itself.\n" + JSON.stringify(schema)
  } : {}) };
}

/** Preserve all historical acyclic identities; new recursive requests bind actual decoding guidance. */
export function geminiGenerationSchemaCacheMaterial(preimage: string): string {
  const schema: unknown = JSON.parse(preimage);
  if (record(schema) === undefined) return preimage;
  const projected = projectGeminiGenerationSchema(schema as object);
  return projected.recursive ? JSON.stringify({ contract: "gemini-recursive-generation-schema-v2",
    source_schema: schema, response_schema: projected.schema, instruction: projected.instruction }) : preimage;
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

function objectAlternatives(node: Schema): boolean {
  if (node.type === "object") return true;
  const alternatives = node.oneOf ?? node.anyOf;
  return Array.isArray(alternatives) && alternatives.length > 0 && alternatives.every(value => {
    const child = record(value); return child !== undefined && objectAlternatives(child);
  });
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
