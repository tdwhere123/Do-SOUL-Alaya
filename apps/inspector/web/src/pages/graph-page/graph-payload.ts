import { z } from "zod";
import {
  SoulPathGraphContractSchema,
  type SoulPathGraphContract
} from "@do-soul/alaya-protocol";

const InspectorPathGraphEnvelopeSchema = z.object({
  success: z.literal(true),
  data: SoulPathGraphContractSchema,
  truncated: z.boolean().optional()
}).passthrough();

export type InspectorPathGraphParse = Readonly<{
  readonly graph: SoulPathGraphContract;
  readonly truncated: boolean;
}>;

export function parseInspectorPathGraph(payload: unknown): InspectorPathGraphParse {
  const envelope = InspectorPathGraphEnvelopeSchema.safeParse(payload);
  if (envelope.success) {
    return {
      graph: envelope.data.data,
      truncated: envelope.data.truncated === true
    };
  }
  return {
    graph: SoulPathGraphContractSchema.parse(payload),
    truncated: truncatedFlag(payload)
  };
}

function truncatedFlag(payload: unknown): boolean {
  return typeof payload === "object" &&
    payload !== null &&
    "truncated" in payload &&
    (payload as { readonly truncated?: unknown }).truncated === true;
}
