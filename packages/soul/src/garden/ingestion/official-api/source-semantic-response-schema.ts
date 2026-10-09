import { z } from "zod";

/** Preserve the producer wire dialect when deriving model-facing response grammars. */
export function producerResponseJsonSchema(schema: z.ZodType, reused?: "ref") {
  return z.toJSONSchema(schema, {
    io: "output",
    ...(reused === undefined ? {} : { reused }),
    override: ({ jsonSchema }) => {
      if (jsonSchema.const !== undefined) {
        jsonSchema.enum = [jsonSchema.const];
        delete jsonSchema.const;
      }
    }
  });
}
