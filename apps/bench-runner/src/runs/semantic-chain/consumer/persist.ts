import { join } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "../contract.js";
import { ConsumerAnswerSchema, type ConsumerLine, TASK_CONSUMER_KIND } from "./input.js";
import { verifyConsumerAuthority, type ConsumerAuthority } from "./authority.js";
import type { ExtractionCacheWriteLease } from "../../extraction/fill/manifest/fill-root-guard.js";
import { isCompleteSemanticFinish } from "../../compile-seed/http/semantic-provider-http.js";
import { inspectExtractionAttemptLedger, openExtractionAttemptLedger } from "../../extraction/authority/attempt-ledger.js";
import { settledAttemptUsageDigest } from "../../extraction/authority/attempt-ledger/outcome.js";
import { baseReportedUsage } from "../../extraction/authority/step-quote.js";
import { isExtractionRequestProfile } from "../../extraction/request-profile.js";
import { bindProviderRawAttempt, providerRawInvalidUsageOutcome, providerRawSuccessEvidenceState,
  readProviderRawAttempt, verifyProviderRawReservation, type ProviderRawAttempt } from "../../extraction/fill/provider-raw-attempt.js";
import type { ProviderRequestDecoded, ProviderRequestPhysicalContext } from "../../provider-request/execution.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const ConsumerOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("complete_response"), answer: ConsumerAnswerSchema }).strict(),
  z.object({ status: z.literal("invalid"), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("incomplete"), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("transport_failure"), failure: z.unknown() }).strict()
]);
const ConsumerResultSchema = z.object({
  contract: z.literal("semantic-chain-consumer-result-v1"), kind: z.literal(TASK_CONSUMER_KIND),
  key: Digest, request_digest: Digest, preparation_identity: Digest, attempt_lineage_digest: Digest,
  attempt_ordinal: z.number().int().positive(), raw_identity: Digest,
  outcome: ConsumerOutcomeSchema, complete_response: z.boolean(), fidelity: z.literal("unassessed")
}).strict();
type ConsumerResult = z.infer<typeof ConsumerResultSchema>;

export function interpretConsumerResponse(decoded: ProviderRequestDecoded) {
  let parsed: unknown;
  try { parsed = JSON.parse(decoded.rawJson); }
  catch { return { classified: "terminal" as const, admitted: false,
    outcome: { status: "invalid", reason: "malformed_json" } }; }
  const answer = ConsumerAnswerSchema.safeParse(parsed);
  if (!answer.success) return { classified: "terminal" as const, admitted: false,
    outcome: { status: "invalid", reason: "answer_schema" } };
  return { classified: "interpreted" as const, admitted: true,
    outcome: { status: "complete_response", answer: answer.data } };
}

export function assertConsumerRaw(raw: ProviderRawAttempt, authority: ConsumerAuthority, line: ConsumerLine,
  ledger: ReturnType<typeof inspectExtractionAttemptLedger>): void {
  bindProviderRawAttempt(raw, { cacheKey: line.key, kind: TASK_CONSUMER_KIND, model: authority.model,
    requestProfile: authority.request_profile, requestDigest: line.requestDigest,
    attemptLineageDigest: authority.attempt_lineage_digest });
  verifyProviderRawReservation(raw, ledger, "executable", authority.limits.max_output_tokens);
}

export function publishConsumerResult(root: string, authority: ConsumerAuthority, line: ConsumerLine,
  published: Parameters<ProviderRequestPhysicalContext["publishArtifact"]>[0]): void {
  const raw = readProviderRawAttempt(root, line.key, published.attemptOrdinal);
  if (raw === undefined || raw.decoded_text !== published.rawJson || raw.finish_reason !== published.finishReason) {
    throw new AlayaError("CONFLICT", "consumer publication requires its exact retained raw response");
  }
  const result = ConsumerResultSchema.parse({ contract: "semantic-chain-consumer-result-v1", kind: TASK_CONSUMER_KIND,
    key: line.key, request_digest: line.requestDigest, preparation_identity: authority.preparation_identity,
    attempt_lineage_digest: authority.attempt_lineage_digest, attempt_ordinal: published.attemptOrdinal,
    raw_identity: chainIdentity(raw), outcome: published.outcome, complete_response: published.admitted,
    fidelity: "unassessed" });
  assertResultRaw(result, raw, authority);
  writeChainArtifact(consumerResultPath(root, line.key), result);
}

export const consumerResultPath = (root: string, key: string): string => join(root, `result-${key}.json`);

export function inspectConsumerResult(root: string, authority: ConsumerAuthority, line: ConsumerLine) {
  const retained = readChainArtifact(consumerResultPath(root, line.key));
  if (retained === undefined) return undefined;
  const result = ConsumerResultSchema.parse(retained);
  if (result.key !== line.key || result.request_digest !== line.requestDigest ||
      result.preparation_identity !== authority.preparation_identity ||
      result.attempt_lineage_digest !== authority.attempt_lineage_digest) {
    throw new AlayaError("CONFLICT", "consumer result differs from its frozen request scope");
  }
  const raw = readProviderRawAttempt(root, line.key, result.attempt_ordinal);
  if (raw === undefined) throw new AlayaError("CONFLICT", "consumer result lacks its retained raw attempt");
  assertConsumerRaw(raw, authority, line, inspectExtractionAttemptLedger({ cacheRoot: root,
    lineageDigest: authority.attempt_lineage_digest, cacheIdentity: cacheIdentity(authority) }));
  assertResultRaw(result, raw, authority);
  return { result, raw };
}

export function openConsumerAttemptLedger(root: string, authority: ConsumerAuthority, lines: readonly ConsumerLine[],
  lease?: ExtractionCacheWriteLease) {
  const admitted = verifyConsumerAuthority(authority, lease);
  if (root !== (lease?.stableRootPath ?? authority.execution_scope.execution_root_path) ||
      canonicalJson(lines) !== canonicalJson(admitted.lines)) {
    throw new AlayaError("CONFLICT", "consumer ledger differs from its admitted execution scope");
  }
  const byKey = new Map(lines.map(line => [line.key, line]));
  return openExtractionAttemptLedger({ cacheRoot: root, publicationTemporaryDirectory: root,
    lineageDigest: authority.attempt_lineage_digest, requireSingleLineageForCacheIdentity: true,
    cacheIdentity: cacheIdentity(authority), startingMissing: lines.length,
    maximumAttempts: authority.limits.maximum_attempts, maximumAttemptsPerKey: 1,
    successfulShardCeiling: authority.limits.successful_shard_ceiling,
    inspectProviderShard: (cacheRoot, key) => {
      const line = byKey.get(key);
      if (line === undefined) throw new AlayaError("CONFLICT", "consumer ledger contains a key outside authority");
      const retained = inspectConsumerResult(cacheRoot, authority, line);
      if (retained === undefined || !retained.result.complete_response) return undefined;
      return { cacheKey: key, rawJsonSha256: retained.raw.decoded_text_digest, successKind: "provider" as const,
        transportProvenance: line.transportProvenance, attemptOrdinal: retained.raw.attempt_ordinal,
        authorityLineageDigest: authority.attempt_lineage_digest,
        usageSha256: settledAttemptUsageDigest(baseReportedUsage(retained.raw.usage)) };
    }
  });
}

function cacheIdentity(authority: ConsumerAuthority) {
  if (!isExtractionRequestProfile(authority.request_profile)) throw new AlayaError("VALIDATION", "unsupported consumer profile");
  return { model: authority.model, requestProfile: authority.request_profile };
}

function assertResultRaw(result: ConsumerResult, raw: ProviderRawAttempt, authority: ConsumerAuthority): void {
  if (result.raw_identity !== chainIdentity(raw)) throw new AlayaError("CONFLICT", "consumer result raw identity changed");
  const response = interpretConsumerResponse({ rawJson: raw.decoded_text, finishReason: raw.finish_reason });
  const complete = raw.full_replay_possible && raw.transport_failure === undefined &&
    providerRawInvalidUsageOutcome(raw, authority.limits.max_output_tokens) === undefined &&
    providerRawSuccessEvidenceState(raw) === "bound" && isCompleteSemanticFinish(authority.request_profile, raw.finish_reason) &&
    response.admitted;
  if (result.complete_response !== complete || result.complete_response !== (result.outcome.status === "complete_response") ||
      complete && canonicalJson(result.outcome) !== canonicalJson(response.outcome)) {
    throw new AlayaError("CONFLICT", "consumer answer differs from its physically complete retained response");
  }
}
