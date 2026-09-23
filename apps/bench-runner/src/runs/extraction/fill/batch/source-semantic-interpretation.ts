import { AlayaError } from "@do-soul/alaya-protocol";
import type { CompileSeedExtractionConfig } from "../../../compile-seed/compile-seed-types.js";
import {
  parseSourceSemanticRequest, receiveSourceSemantics,
  type SourceSemanticProposalInput
} from "@do-soul/alaya-soul";
import type { GeminiBatchInvocation, GeminiBatchLine, GeminiBatchPlan } from "./contract.js";
import { canonicalBatchPlan } from "./plan.js";
import { parseSourceSemanticRequestLine } from "../../request-artifact.js";

// Snapshot association still imports this name until its isolated migration lands.
export { prepareSourceSemanticRequestLine as prepareSourceSemanticBatchLine } from "../../request-artifact.js";

/** Returned drafts still require Core publication; a parser success is not publication. */
export function receiveSourceSemanticBatchLine(input: Readonly<{
  config: Pick<CompileSeedExtractionConfig, "model" | "requestProfile">;
  line: GeminiBatchLine; rawJson: string; sourceCorpus: string;
  proposal: SourceSemanticProposalInput;
  retained?: Readonly<{ plan: GeminiBatchPlan; provenance: Parameters<GeminiBatchInvocation["importLine"]>[0]["provenance"] }>;
}>) {
  const request = parseSourceSemanticRequest(JSON.parse(input.line.userPrompt));
  parseSourceSemanticRequestLine(input.line, input.config);
  const retained = input.retained;
  if (retained !== undefined) canonicalBatchPlan(retained.plan);
  if (retained !== undefined && (retained.provenance.attemptOrdinal === undefined ||
      !retained.plan.lines.some((line) => JSON.stringify(line) === JSON.stringify(input.line)))) {
    throw new AlayaError("CONFLICT", "Batch open semantics is missing its retained plan/attempt binding");
  }
  return receiveSourceSemantics(input.rawJson, request, input.proposal);
}
