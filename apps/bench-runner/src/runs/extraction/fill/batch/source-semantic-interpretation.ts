import { AlayaError } from "@do-soul/alaya-protocol";
import { computeCacheKey } from "../../../compile-seed/cache/cache-key.js";
import type { CompileSeedExtractionConfig } from "../../../compile-seed/compile-seed-types.js";
import { createHash } from "node:crypto";
import {
  sourceSemanticSystemPrompt, parseSourceSemanticRequest, receiveSourceSemantics,
  type SourceSemanticProposalInput, type SourceSemanticRequest
} from "@do-soul/alaya-soul";
import type { GeminiBatchInvocation, GeminiBatchLine, GeminiBatchPlan } from "./contract.js";
import { canonicalBatchPlan } from "./plan.js";

export function prepareSourceSemanticBatchLine(requestValue: SourceSemanticRequest,
  unitKeys: readonly string[], config: Pick<CompileSeedExtractionConfig, "model" | "requestProfile">): GeminiBatchLine {
  const request = parseSourceSemanticRequest(requestValue);
  const userPrompt = JSON.stringify(request);
  const systemPrompt = sourceSemanticSystemPrompt(request);
  return { key: computeCacheKey(config.model, config.requestProfile, systemPrompt, userPrompt), unitKeys,
    requestSha256: createHash("sha256").update(userPrompt).digest("hex"),
    systemPrompt, userPrompt };
}

/** Returned drafts still require Core publication; a parser success is not publication. */
export function receiveSourceSemanticBatchLine(input: Readonly<{
  config: Pick<CompileSeedExtractionConfig, "model" | "requestProfile">;
  line: GeminiBatchLine; rawJson: string; sourceCorpus: string;
  proposal: SourceSemanticProposalInput;
  retained?: Readonly<{ plan: GeminiBatchPlan; provenance: Parameters<GeminiBatchInvocation["importLine"]>[0]["provenance"] }>;
}>) {
  const request = parseSourceSemanticRequest(JSON.parse(input.line.userPrompt));
  const expected = prepareSourceSemanticBatchLine(request, input.line.unitKeys, input.config);
  if (expected.key !== input.line.key || expected.requestSha256 !== input.line.requestSha256 ||
      expected.systemPrompt !== input.line.systemPrompt) throw new AlayaError("CONFLICT", "Batch open-semantics line identity mismatch");
  const retained = input.retained;
  if (retained !== undefined) canonicalBatchPlan(retained.plan);
  if (retained !== undefined && (retained.provenance.attemptOrdinal === undefined ||
      !retained.plan.lines.some((line) => JSON.stringify(line) === JSON.stringify(input.line)))) {
    throw new AlayaError("CONFLICT", "Batch open semantics is missing its retained plan/attempt binding");
  }
  return receiveSourceSemantics(input.rawJson, request, input.proposal);
}
