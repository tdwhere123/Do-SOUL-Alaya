/**
 * Derives MCP JSON Schema from Zod. This catalog is a lossy projection of
 * representable Zod constraints (maxLength, enums, required keys). Runtime
 * `superRefine` / custom refinements do not appear here; the Zod parse at
 * the tool handler is the authority. Do not hand-write a second MCP schema
 * dialect. See invariant §25.
 */
import { z } from "zod";

export function deriveJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const result = z.toJSONSchema(schema, {
    target: "openapi-3.0",
    io: "input",
    reused: "inline",
    unrepresentable: "any"
  });
  if (!isJsonObject(result)) {
    throw new Error("Derived MCP JSON schema must be an object");
  }
  return stripMcpJsonSchemaMetadata(result);
}

function stripMcpJsonSchemaMetadata(node: Record<string, unknown>): Record<string, unknown> {
  const stripped = stripJsonSchemaNode(node);
  if (!isJsonObject(stripped)) {
    throw new Error("Derived MCP JSON schema must stay an object");
  }
  return stripped;
}

function stripJsonSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => stripJsonSchemaNode(item));
  }
  if (node === null || typeof node !== "object") {
    return node;
  }

  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema" || key === "$defs" || key === "definitions" || key === "readOnly") {
      continue;
    }
    stripped[key] = stripJsonSchemaNode(value);
  }
  return stripped;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
