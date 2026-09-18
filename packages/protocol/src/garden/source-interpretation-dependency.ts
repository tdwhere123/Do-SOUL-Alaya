import { z } from "zod";
import { SourceEvidenceTargetSchema } from "../recall/conditional-field/product-identity.js";
import { SOURCE_INTERPRETATION_CONTRACT } from "./source-interpretation.js";
import { PublishedSourceInterpretationPacketSchema } from "./source-interpretation-packet.js";

export const SOURCE_INTERPRETATION_DEPENDENCY_CONTRACTS = [
  SOURCE_INTERPRETATION_CONTRACT, PublishedSourceInterpretationPacketSchema.unwrap().shape.contract.value
] as const;

// This recognizes source dependency for erasure, not semantic admission of the payload.
const DependencySchema = z.object({ contract: z.enum(SOURCE_INTERPRETATION_DEPENDENCY_CONTRACTS),
  source_target: SourceEvidenceTargetSchema }).passthrough();

export function sourceInterpretationDependsOnRecord(gist: string, workspaceId: string, recordId: string): boolean {
  let value: unknown;
  try { value = JSON.parse(gist); } catch { return false; }
  const parsed = DependencySchema.safeParse(value);
  if (!parsed.success) return false;
  const target = parsed.data.source_target;
  return target.workspace_id === workspaceId && target.root_kind === "source_record" && target.root_id === recordId;
}
