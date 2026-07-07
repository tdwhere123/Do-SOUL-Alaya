import { describe, expect, it } from "vitest";
import { z } from "zod";

import { deriveJsonSchema } from "../../soul/mcp-json-schema.js";

describe("deriveJsonSchema", () => {
  it("is idempotent and strips MCP-irrelevant metadata without readOnly leakage", () => {
    const schema = z
      .object({
        query: z.string().max(128),
        nested: z
          .object({
            label: z.string()
          })
          .strict()
          .readonly(),
        items: z
          .array(
            z
              .object({
                id: z.string()
              })
              .strict()
              .readonly()
          )
          .readonly()
      })
      .strict()
      .readonly();

    const first = deriveJsonSchema(schema);
    const second = deriveJsonSchema(schema);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain('"$schema"');
    expect(JSON.stringify(first)).not.toContain('"$defs"');
    expect(JSON.stringify(first)).not.toContain('"definitions"');
    expect(JSON.stringify(first)).not.toContain('"readOnly"');
  });

  it("does not share mutable schema objects across derivations", () => {
    const schema = z.object({ query: z.string() }).strict().readonly();
    const first = deriveJsonSchema(schema);
    const second = deriveJsonSchema(schema);

    first["x-mutated-by-caller"] = true;

    expect(second).not.toHaveProperty("x-mutated-by-caller");
  });
});
