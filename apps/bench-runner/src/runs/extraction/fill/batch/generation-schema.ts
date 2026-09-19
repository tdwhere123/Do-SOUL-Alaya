type Schema = Record<string, unknown>;
const mapPositions = ["properties", "patternProperties", "dependentSchemas"];
const listPositions = ["allOf", "anyOf", "oneOf", "prefixItems"];
const singlePositions = ["items", "additionalProperties", "contains", "not", "if", "then", "else",
  "propertyNames", "unevaluatedProperties", "unevaluatedItems"];

/** Provider decoding guidance is weaker than local admission, which keeps every required field. */
export function projectGeminiGenerationSchema(schema: object): { schema: object; recursive: boolean } {
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
  const recursiveProperty = (value: unknown): boolean => {
    const node = record(value); if (node === undefined) return false;
    if (typeof node.$ref === "string") return cycle(node);
    // Descendant object properties own their own required arrays. Keep their
    // containers mandatory; only the property actually containing a cyclic ref relaxes.
    return schemaChildren(node, false).some(recursiveProperty);
  };
  const visit = (value: unknown): unknown => {
    const node = record(value); if (node === undefined) return value;
    const properties = record(node.properties);
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "maxItems").map(([key, child]) => {
      if (key === "required" && Array.isArray(child) && properties !== undefined) {
        // GenerateContent only permits cyclic references in non-required properties.
        // Do not change the source schema: the host must reject omitted operands.
        return [key, child.filter(name => {
          if (typeof name !== "string" || !recursiveProperty(properties[name])) return true;
          recursive = true; return false;
        })];
      }
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
  return { schema: projected, recursive };
}

/** Preserve all historical acyclic identities; new recursive requests bind actual decoding guidance. */
export function geminiGenerationSchemaCacheMaterial(preimage: string): string {
  const schema: unknown = JSON.parse(preimage);
  if (record(schema) === undefined) return preimage;
  const projected = projectGeminiGenerationSchema(schema as object);
  return projected.recursive ? JSON.stringify({ contract: "gemini-recursive-generation-schema-v1",
    source_schema: schema, response_schema: projected.schema }) : preimage;
}

function record(value: unknown): Schema | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Schema : undefined;
}

function schemaChildren(node: Schema, includeProperties = true): unknown[] {
  const children: unknown[] = [];
  if (includeProperties) for (const key of mapPositions) { const map = record(node[key]); if (map !== undefined) children.push(...Object.values(map)); }
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
