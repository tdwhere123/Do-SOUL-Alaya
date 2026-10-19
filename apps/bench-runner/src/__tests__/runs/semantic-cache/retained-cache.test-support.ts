import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isChatSemanticRequestProfile } from "@do-soul/alaya-protocol";
import { materializeSemanticProposalLines, type SemanticProposalWorkset } from "../../../runs/semantic-cache/workset.js";
import { semanticProposalLookup } from "../../../runs/semantic-cache/attempt.js";
import { receiveLine, isCoreAdmittedProposal } from "../../../runs/semantic-cache/results.js";
import { SemanticProposalShardSchema, semanticProposalShardPath } from "../../../runs/semantic-cache/artifact.js";
import { ledgerPath } from "../../../runs/extraction/authority/attempt-ledger.js";
import { emptyAttemptTelemetry, persistAttemptLedgerRecord, type ExtractionAttemptLedgerRecord } from
  "../../../runs/extraction/authority/attempt-ledger/contract.js";
import { settledAttemptUsageDigest } from "../../../runs/extraction/authority/attempt-ledger/outcome.js";
import { isExtractionRequestProfile } from "../../../runs/extraction/request-profile.js";
import { writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { syntheticGeminiBody } from "../provider-request/gemini-response-evidence.test-support.js";

/** Authored retained evidence only: no producer, execution authority, provider or recovery. */
export function seedRetainedSemanticCache(workset: SemanticProposalWorkset, cacheRoot: string,
  maxOutputTokens: number, rawForPrompt: (userPrompt: string) => string) {
  const lines = materializeSemanticProposalLines(workset, maxOutputTokens);
  if (!isExtractionRequestProfile(workset.request_profile)) throw new Error("fixture requires a native profile");
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const usageSha256 = settledAttemptUsageDigest(usage);
  const lineage = semanticProposalLookup(workset, lines[0]!, maxOutputTokens).attempt_lineage_digest!;
  const successful: ExtractionAttemptLedgerRecord["successful_shards"][number][] = [];
  const settled: NonNullable<ExtractionAttemptLedgerRecord["settled_attempts"]>[number][] = [];
  let admittedCount = 0;
  for (const [index, line] of lines.entries()) {
    const ordinal = index + 1, rawJson = rawForPrompt(line.userPrompt);
    const received = receiveLine(line, rawJson), admitted = isCoreAdmittedProposal(line, received);
    admittedCount += Number(admitted);
    const chat = isChatSemanticRequestProfile(workset.request_profile), finish = chat ? "stop" : "STOP";
    const body = Buffer.from(JSON.stringify({ choices: [{ message: { content: rawJson }, finish_reason: finish }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    const raw = writeProviderRawAttempt({ root: cacheRoot, cacheKey: line.key, attemptOrdinal: ordinal,
      kind: workset.kind, attemptLineageDigest: lineage, model: workset.model, requestProfile: workset.request_profile,
      requestDigest: line.requestDigest, decodedText: rawJson, finishReason: finish, usage,
      ...(chat ? { httpResponse: { contentType: "application/json", bodyBase64: body.toString("base64"),
        bodyByteLength: body.length, bodySha256: createHash("sha256").update(body).digest("hex"),
        bodyComplete: true, bodyTruncated: false } } : { responseBody: syntheticGeminiBody(rawJson, finish, usage) }) });
    const shard = SemanticProposalShardSchema.parse({ contract: "source-semantic-proposal-cache-v3",
      kind: workset.kind, cache_key: line.key, model: workset.model, request_profile: workset.request_profile,
      original_query: line.original_query, system_prompt: line.systemPrompt, user_prompt: line.userPrompt,
      raw_json: rawJson, outcome: received.outcome, admitted, attempt_ordinal: ordinal,
      attempt_lineage_digest: lineage, request_digest: line.requestDigest, extracted_at: raw.extracted_at,
      usage, finish_reason: finish, completion_witness: "finish_reason", raw_digest: raw.decoded_text_digest,
      max_output_tokens: maxOutputTokens, transport_provenance: line.transportProvenance });
    const path = semanticProposalShardPath(cacheRoot, line.key);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(shard));
    settled.push({ attempt_ordinal: ordinal, cache_key: line.key, usage_sha256: usageSha256 });
    if (admitted) successful.push({ cacheKey: line.key, rawJsonSha256: raw.decoded_text_digest,
      successKind: "provider", transportProvenance: line.transportProvenance, attemptOrdinal: ordinal,
      authorityLineageDigest: lineage, usageSha256 });
  }
  persistAttemptLedgerRecord(ledgerPath(cacheRoot, lineage), { schema_version: 5, lineage_digest: lineage,
    cache_identity: { model: workset.model, requestProfile: workset.request_profile }, starting_missing: lines.length,
    maximum_attempts: lines.length, successful_shard_ceiling: lines.length, attempts: lines.length,
    successful_shards: successful, pending_keys: [], unresolved_attempts: [], settled_attempts: settled,
    transport_failures: [], telemetry: { ...emptyAttemptTelemetry(), input_tokens: lines.length,
      output_tokens: lines.length, total_tokens: lines.length * 2 } }, cacheRoot);
  return { lines, admittedCount };
}
