import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { isCompleteSemanticFinish } from "../compile-seed/http/semantic-provider-http.js";
import { inspectExtractionAttemptLedger, openExtractionAttemptLedger, classifyRetainedExtractionAttemptState,
  type ExtractionAttemptLedgerSnapshot } from "../extraction/authority/attempt-ledger.js";
import { settledAttemptUsageDigest } from "../extraction/authority/attempt-ledger/outcome.js";
import { baseReportedUsage } from "../extraction/authority/step-quote.js";
import { boundedArtifactEntryExists, readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { publishBytesExclusiveDurable } from "../extraction/fill/manifest/durable-exclusive-publication.js";
import { bindProviderRawAttempt, listProviderRawAttempts, providerRawSuccessEvidenceState, providerRawInvalidUsageOutcome, verifyProviderRawReservation,
  type ProviderRawAttempt } from "../extraction/fill/provider-raw-attempt.js";
import type { ProviderRequestDecoded, ProviderRequestPhysicalContext } from "../provider-request/execution.js";
import { frozenAnswerCacheIdentity, type FrozenAnswerGrant } from "./authority.js";
import { FROZEN_ANSWER_KIND, FrozenAnswerResponse, type FrozenAnswerLine } from "./input.js";

const Terminal = z.object({ key: z.string(), request_digest: z.string(), lineage: z.string(), ordinal: z.number().int().positive(),
  raw_json: z.string(), admitted: z.boolean(), outcome: z.unknown(), finish_reason: z.string().nullable(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number() }).optional() }).strict();
const terminalPath = (root: string, key: string) => join(root, `${key}.answer.json`);

export function interpretFrozenAnswer(line: FrozenAnswerLine, decoded: ProviderRequestDecoded) {
  if (decoded.usage === undefined) return { classified: "unknown" as const, admitted: false, outcome: { status: "unknown_usage" } };
  if (decoded.usage.inputTokens > line.inputByteUpper) return { classified: "terminal" as const, admitted: false,
    outcome: { status: "rejected", reason: "input_bound_exceeded" } };
  let value: unknown;
  try { value = JSON.parse(decoded.rawJson); } catch { value = null; }
  const parsed = FrozenAnswerResponse.safeParse(value);
  return parsed.success ? { classified: "interpreted" as const, admitted: true, outcome: { status: "answered", answer: parsed.data.answer } }
    : { classified: "terminal" as const, admitted: false, outcome: { status: "rejected", reason: "answer_schema" } };
}

export function assertAnswerRaw(raw: ProviderRawAttempt, grant: FrozenAnswerGrant, line: FrozenAnswerLine,
  ledger: ExtractionAttemptLedgerSnapshot | undefined) {
  bindProviderRawAttempt(raw, { cacheKey: line.key, kind: FROZEN_ANSWER_KIND, model: grant.model,
    requestProfile: grant.request_profile, requestDigest: line.requestDigest, attemptLineageDigest: grant.lineage });
  verifyProviderRawReservation(raw, ledger, "executable", grant.limits.max_output_tokens);
}

/** Retained raw is the recovery authority. A terminal alone never establishes success. */
export function readFrozenAnswerResult(root: string, grant: FrozenAnswerGrant, line: FrozenAnswerLine) {
  const ledger = inspectExtractionAttemptLedger({ cacheRoot: root, lineageDigest: grant.lineage, cacheIdentity: frozenAnswerCacheIdentity(grant) });
  const raws = listProviderRawAttempts(root, line.key);
  for (const raw of raws) assertAnswerRaw(raw, grant, line, ledger);
  const path = terminalPath(root, line.key);
  const terminal = !boundedArtifactEntryExists(path) ? undefined : Terminal.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: 8 * 1024 * 1024, label: "frozen answer terminal" })));
  const raw = terminal && raws.find(item => item.attempt_ordinal === terminal.ordinal);
  if (terminal && !raw) return { status: "incomplete", ledger, terminal };
  if (terminal && raw) {
    if (terminal.key !== line.key || terminal.request_digest !== line.requestDigest || terminal.lineage !== grant.lineage ||
      terminal.raw_json !== raw.decoded_text || terminal.finish_reason !== raw.finish_reason ||
      (terminal.admitted || terminal.usage !== undefined) && canonicalJson(terminal.usage ?? null) !== canonicalJson(baseReportedUsage(raw.usage) ?? null)) {
      throw new AlayaError("CONFLICT", "frozen answer terminal/raw binding drift");
    }
    if (terminal.admitted) {
      const interpreted = interpretFrozenAnswer(line, { rawJson: raw.decoded_text, finishReason: raw.finish_reason,
        usage: baseReportedUsage(raw.usage) });
      if (!interpreted.admitted || canonicalJson(interpreted.outcome) !== canonicalJson(terminal.outcome) ||
        !raw.full_replay_possible || providerRawSuccessEvidenceState(raw) !== "bound" ||
        !isCompleteSemanticFinish(grant.request_profile, raw.finish_reason)) {
        throw new AlayaError("CONFLICT", "frozen answer terminal lacks complete raw admission");
      }
    }
  }
  const state = classifyRetainedExtractionAttemptState(ledger, line.key, raws.map(raw => raw.attempt_ordinal), terminal !== undefined);
  if (state !== "settled") return { status: state, ledger, terminal };
  if (!terminal) return { status: "unattempted", ledger, terminal };
  if (terminal.admitted) {
    const success = ledger?.successfulEntries.find(entry => entry.cacheKey === line.key);
    if (success === undefined) return { status: "pending", ledger, terminal };
    if (success.successKind !== "provider" || success.rawJsonSha256 !== raw!.decoded_text_digest ||
      success.attemptOrdinal !== terminal.ordinal || success.authorityLineageDigest !== grant.lineage ||
      success.usageSha256 !== settledAttemptUsageDigest(terminal.usage) ||
      canonicalJson(success.transportProvenance) !== canonicalJson(line.transportProvenance)) {
      throw new AlayaError("CONFLICT", "answer success differs from durable ledger admission");
    }
  }
  return { status: terminal.admitted ? "answered" : rejectedAnswerStatus(raw!, grant, line), ledger, terminal };
}

function rejectedAnswerStatus(raw: ProviderRawAttempt, grant: FrozenAnswerGrant, line: FrozenAnswerLine): string {
  if (providerRawInvalidUsageOutcome(raw, grant.limits.max_output_tokens) !== undefined) return "rejected";
  if (raw.transport_failure !== undefined) return "transport_failure";
  if (!raw.full_replay_possible || providerRawSuccessEvidenceState(raw) !== "bound" ||
    !isCompleteSemanticFinish(grant.request_profile, raw.finish_reason)) return "incomplete";
  const interpreted = interpretFrozenAnswer(line, { rawJson: raw.decoded_text, finishReason: raw.finish_reason,
    usage: baseReportedUsage(raw.usage) });
  if (interpreted.admitted) throw new AlayaError("CONFLICT", "rejected answer contradicts its retained raw");
  return interpreted.classified === "unknown" ? "unknown_usage" : "rejected";
}

export function openFrozenAnswerLedger(root: string, grant: FrozenAnswerGrant, lines: readonly FrozenAnswerLine[]) {
  return openExtractionAttemptLedger({ cacheRoot: root, publicationTemporaryDirectory: root, lineageDigest: grant.lineage,
    cacheIdentity: frozenAnswerCacheIdentity(grant), requireSingleLineageForCacheIdentity: true,
    startingMissing: grant.tasks.length, maximumAttempts: grant.limits.maximum_attempts,
    maximumAttemptsPerKey: 1, successfulShardCeiling: grant.tasks.length,
    inspectProviderShard: (cacheRoot, key) => {
      const line = lines.find(item => item.key === key);
      if (!line) throw new AlayaError("CONFLICT", "ungranted answer shard");
      const result = readFrozenAnswerResult(cacheRoot, grant, line), terminal = result.terminal;
      if (!terminal?.admitted || result.status === "incomplete") return undefined;
      return { cacheKey: key, rawJsonSha256: createHash("sha256").update(terminal.raw_json).digest("hex"),
        successKind: "provider", transportProvenance: line.transportProvenance, attemptOrdinal: terminal.ordinal,
        authorityLineageDigest: grant.lineage, usageSha256: settledAttemptUsageDigest(terminal.usage) };
    } });
}

export function publishFrozenAnswer(root: string, grant: FrozenAnswerGrant,
  published: Parameters<ProviderRequestPhysicalContext["publishArtifact"]>[0]) {
  const terminal = { key: published.line.key, request_digest: published.line.requestDigest, lineage: grant.lineage,
    ordinal: published.attemptOrdinal, raw_json: published.rawJson, admitted: published.admitted,
    outcome: published.outcome, finish_reason: published.finishReason,
    ...(published.usage === undefined ? {} : { usage: published.usage }) };
  publishBytesExclusiveDurable({ destination: terminalPath(root, published.line.key),
    bytes: Buffer.from(JSON.stringify(terminal)), ownerIdentity: grant.lineage, temporaryDirectory: root, allowExistingExact: true });
}
