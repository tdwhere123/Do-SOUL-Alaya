import { z } from "zod";

export function deriveJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const result = z.toJSONSchema(schema, {
    target: "openapi-3.0",
    io: "input",
    reused: "inline",
    unrepresentable: "any"
  }) as Record<string, unknown>;
  // Strip the JSON Schema metadata fields that MCP clients do not need;
  // they would otherwise leak the upstream draft URI and inflate every
  // tools/list payload.
  delete result["$schema"];
  delete result["$defs"];
  delete result["definitions"];
  // zod `.readonly()` projects to `readOnly: true`; on a request *input* schema
  // that wrongly signals MCP clients not to send the field, so drop it tree-wide.
  stripReadOnly(result);
  return result;
}

function stripReadOnly(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      stripReadOnly(item);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  delete record["readOnly"];
  for (const value of Object.values(record)) {
    stripReadOnly(value);
  }
}
