import { AlayaError } from "@do-soul/alaya-protocol";
import { computeCacheKey } from "../../../compile-seed/cache/cache-key.js";
import type { CompileSeedExtractionConfig } from "../../../compile-seed/compile-seed-types.js";
import { createHash } from "node:crypto";
import { OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT, parseOfficialApiSourcePacketRequest,
  receiveOfficialApiSourcePacket, type OfficialApiSourcePacketRequest } from "@do-soul/alaya-soul";
import type { GeminiBatchInvocation, GeminiBatchLine, GeminiBatchPlan } from "./contract.js";
import { canonicalBatchPlan } from "./plan.js";

/** Explicit new-contract input for the existing Batch planner and native codec. */
export function prepareSourceInterpretationPacketBatchLine(requestValue: OfficialApiSourcePacketRequest,
  unitKeys: readonly string[], config: Pick<CompileSeedExtractionConfig, "model" | "requestProfile">): GeminiBatchLine {
  const request = parseOfficialApiSourcePacketRequest(requestValue);
  const userPrompt = JSON.stringify(request);
  return { key: computeCacheKey(config.model, config.requestProfile, OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT, userPrompt), unitKeys,
    requestSha256: createHash("sha256").update(userPrompt).digest("hex"),
    systemPrompt: OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT, userPrompt };
}

/** Returned drafts still require Core publication; a parser success is not publication. */
export function receiveSourceInterpretationPacketBatchLine(input: Readonly<{
  config: Pick<CompileSeedExtractionConfig, "model" | "requestProfile">;
  line: GeminiBatchLine; rawJson: string; sourceCorpus: string; artifactKey: string; producerId: string;
  retained?: Readonly<{ plan: GeminiBatchPlan; provenance: Parameters<GeminiBatchInvocation["importLine"]>[0]["provenance"] }>;
}>) {
  const request = parseOfficialApiSourcePacketRequest(JSON.parse(input.line.userPrompt));
  const expected = prepareSourceInterpretationPacketBatchLine(request, input.line.unitKeys, input.config);
  if (expected.key !== input.line.key || expected.requestSha256 !== input.line.requestSha256 ||
      expected.systemPrompt !== input.line.systemPrompt) throw new AlayaError("CONFLICT", "Batch packet line identity mismatch");
  const retained = input.retained;
  if (retained !== undefined) canonicalBatchPlan(retained.plan);
  if (retained !== undefined && (retained.provenance.attemptOrdinal === undefined ||
      !retained.plan.lines.some((line) => JSON.stringify(line) === JSON.stringify(input.line)))) {
    throw new AlayaError("CONFLICT", "Batch packet is missing its retained plan/attempt binding");
  }
  const transport = retained === undefined ? { kind: "unavailable" as const } : {
    kind: "gemini_batch" as const, plan_identity: retained.plan.identity, model: retained.plan.model,
    request_profile: retained.plan.requestProfile, max_output_tokens: retained.plan.limits.maxOutputTokens,
    request_sha256: input.line.requestSha256, job: retained.provenance.job, input_file: retained.provenance.inputFile,
    input_sha256: retained.provenance.inputSha256, output_sha256: retained.provenance.outputSha256,
    response_sha256: retained.provenance.responseSha256, finish_reason: retained.provenance.finishReason,
    attempt_ordinal: retained.provenance.attemptOrdinal!
  };
  return receiveOfficialApiSourcePacket(input.rawJson, request, { ...input, transport });
}
