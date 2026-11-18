import { createHash } from "node:crypto";
import { join } from "node:path";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { isCompleteSemanticFinish } from "../../compile-seed/http/semantic-provider-http.js";
import { inspectExtractionAttemptLedger, openExtractionAttemptLedger, classifyRetainedExtractionAttemptState,
  type ExtractionAttemptLedgerSnapshot } from "../../extraction/authority/attempt-ledger.js";
import { settledAttemptUsageDigest } from "../../extraction/authority/attempt-ledger/outcome.js";
import { baseReportedUsage } from "../../extraction/authority/step-quote.js";
import { boundedArtifactEntryExists, readBoundedCanonicalUtf8Artifact } from "../../extraction/cache-audit/bounded-artifact-reader.js";
import { publishBytesExclusiveDurable } from "../../extraction/fill/manifest/durable-exclusive-publication.js";
import { bindProviderRawAttempt, listProviderRawAttempts, providerRawSuccessEvidenceState, providerRawInvalidUsageOutcome, verifyProviderRawReservation,
  type ProviderRawAttempt } from "../../extraction/fill/provider-raw-attempt.js";
import type { ProviderRequestDecoded, ProviderRequestPhysicalContext } from "../../provider-request/execution.js";
import { decodeTextMcpAction } from "./codec.js";
import { textMcpProviderSessionCacheIdentity, type TextMcpProviderSessionGrant } from "./session-authority.js";
import { type TextMcpProviderSessionLine } from "./session-request.js";
import { TEXT_MCP_SESSION_TERMINAL_MAX_BYTES, TextMcpSessionTerminalSchema } from "./session-turn-artifact.js";

const terminalPath = (root: string, key: string) => join(root, `${key}.turn.json`);

export function interpretTextMcpProviderSession(line: TextMcpProviderSessionLine, decoded: ProviderRequestDecoded,
  maxOutputBytes: number) {
  if (decoded.usage === undefined) return { classified: "unknown" as const, admitted: false, outcome: { status: "unknown_usage" } };
  if (decoded.usage.inputTokens > line.inputByteUpper) {
    return { classified: "terminal" as const, admitted: false, outcome: { status: "rejected", reason: "input_bound_exceeded" } };
  }
  if (Buffer.byteLength(decoded.rawJson, "utf8") > maxOutputBytes) {
    return { classified: "terminal" as const, admitted: false, outcome: { status: "rejected", reason: "output_ceiling" } };
  }
  const decodedAction = decodeTextMcpAction(decoded.rawJson);
  if (decodedAction.kind === "invalid_action") {
    return { classified: "terminal" as const, admitted: false, outcome: { status: "invalid_action", reason: decodedAction.reason } };
  }
  if (decodedAction.kind === "host_policy_refusal") {
    return {
      classified: "terminal" as const, admitted: false,
      outcome: { status: "host_policy_refusal", tool: decodedAction.tool, reason: decodedAction.reason }
    };
  }
  return { classified: "interpreted" as const, admitted: true, outcome: { status: decodedAction.kind, action: decodedAction } };
}

export function assertSessionRaw(raw: ProviderRawAttempt, grant: TextMcpProviderSessionGrant, line: TextMcpProviderSessionLine,
  ledger: ExtractionAttemptLedgerSnapshot | undefined) {
  bindProviderRawAttempt(raw, { cacheKey: line.key, kind: "task_consumer", model: grant.model,
    requestProfile: grant.request_profile, requestDigest: line.request_digest, attemptLineageDigest: grant.lineage });
  verifyProviderRawReservation(raw, ledger, "executable", grant.limits.max_output_tokens);
}

/** Retained raw is the recovery authority. A terminal alone never establishes success. */
export function readTextMcpProviderSessionResult(root: string, grant: TextMcpProviderSessionGrant, line: TextMcpProviderSessionLine) {
  const ledger = inspectExtractionAttemptLedger({ cacheRoot: root, lineageDigest: grant.lineage,
    cacheIdentity: textMcpProviderSessionCacheIdentity(grant) });
  const raws = listProviderRawAttempts(root, line.key);
  for (const raw of raws) assertSessionRaw(raw, grant, line, ledger);
  const path = terminalPath(root, line.key);
  const terminal = !boundedArtifactEntryExists(path) ? undefined : TextMcpSessionTerminalSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: TEXT_MCP_SESSION_TERMINAL_MAX_BYTES, label: "provider session terminal"
  })));
  const raw = terminal && raws.find(item => item.attempt_ordinal === terminal.ordinal);
  if (terminal && !raw) return { status: "incomplete", ledger, terminal };
  if (terminal && raw) {
    if (terminal.key !== line.key || terminal.request_digest !== line.request_digest || terminal.lineage !== grant.lineage ||
      terminal.raw_json !== raw.decoded_text || terminal.finish_reason !== raw.finish_reason ||
      (terminal.admitted || terminal.usage !== undefined) && canonicalJson(terminal.usage ?? null) !== canonicalJson(baseReportedUsage(raw.usage) ?? null)) {
      throw new AlayaError("CONFLICT", "provider session terminal/raw binding drift");
    }
    if (terminal.admitted) {
      const interpreted = interpretTextMcpProviderSession(line, { rawJson: raw.decoded_text, finishReason: raw.finish_reason,
        usage: baseReportedUsage(raw.usage) }, grant.limits.max_output_bytes);
      if (!interpreted.admitted || canonicalJson(interpreted.outcome) !== canonicalJson(terminal.outcome) ||
        !raw.full_replay_possible || providerRawSuccessEvidenceState(raw) !== "bound" ||
        !isCompleteSemanticFinish(grant.request_profile, raw.finish_reason)) {
        throw new AlayaError("CONFLICT", "provider session terminal lacks complete raw admission");
      }
    }
  }
  const state = classifyRetainedExtractionAttemptState(ledger, line.key, raws.map(item => item.attempt_ordinal), terminal !== undefined);
  if (state !== "settled") return { status: state, ledger, terminal };
  if (!terminal) return { status: "unattempted", ledger, terminal };
  if (terminal.admitted) {
    const success = ledger?.successfulEntries.find(entry => entry.cacheKey === line.key);
    if (success === undefined) return { status: "pending", ledger, terminal };
    if (success.successKind !== "provider" || success.rawJsonSha256 !== raw!.decoded_text_digest ||
      success.attemptOrdinal !== terminal.ordinal || success.authorityLineageDigest !== grant.lineage ||
      success.usageSha256 !== settledAttemptUsageDigest(terminal.usage) ||
      canonicalJson(success.transportProvenance) !== canonicalJson(line.transportProvenance)) {
      throw new AlayaError("CONFLICT", "session success differs from durable ledger admission");
    }
  }
  return { status: terminal.admitted ? "admitted" : rejectedSessionStatus(raw!, grant, line), ledger, terminal };
}

function rejectedSessionStatus(raw: ProviderRawAttempt, grant: TextMcpProviderSessionGrant, line: TextMcpProviderSessionLine): string {
  if (providerRawInvalidUsageOutcome(raw, grant.limits.max_output_tokens) !== undefined) return "rejected";
  if (raw.transport_failure !== undefined) return "transport_failure";
  if (!raw.full_replay_possible || providerRawSuccessEvidenceState(raw) !== "bound" ||
    !isCompleteSemanticFinish(grant.request_profile, raw.finish_reason)) return "incomplete";
  const interpreted = interpretTextMcpProviderSession(line, { rawJson: raw.decoded_text, finishReason: raw.finish_reason,
    usage: baseReportedUsage(raw.usage) }, grant.limits.max_output_bytes);
  if (interpreted.admitted) throw new AlayaError("CONFLICT", "rejected session turn contradicts its retained raw");
  return interpreted.classified === "unknown" ? "unknown_usage" : "rejected";
}

export function openTextMcpProviderSessionLedger(root: string, grant: TextMcpProviderSessionGrant,
  lines: readonly TextMcpProviderSessionLine[]) {
  return openExtractionAttemptLedger({ cacheRoot: root, publicationTemporaryDirectory: root, lineageDigest: grant.lineage,
    cacheIdentity: textMcpProviderSessionCacheIdentity(grant), requireSingleLineageForCacheIdentity: true,
    startingMissing: grant.limits.max_model_turns, maximumAttempts: grant.limits.maximum_attempts,
    maximumAttemptsPerKey: 1, successfulShardCeiling: grant.limits.max_model_turns,
    inspectProviderShard: (cacheRoot, key) => {
      const line = lines.find(item => item.key === key);
      if (!line) throw new AlayaError("CONFLICT", "ungranted session shard");
      const result = readTextMcpProviderSessionResult(cacheRoot, grant, line), terminal = result.terminal;
      if (!terminal?.admitted || result.status === "incomplete") return undefined;
      return { cacheKey: key, rawJsonSha256: createHash("sha256").update(terminal.raw_json).digest("hex"),
        successKind: "provider" as const, transportProvenance: line.transportProvenance, attemptOrdinal: terminal.ordinal,
        authorityLineageDigest: grant.lineage, usageSha256: settledAttemptUsageDigest(terminal.usage) };
    } });
}

export function publishTextMcpProviderSessionTurn(root: string, grant: TextMcpProviderSessionGrant,
  published: Parameters<ProviderRequestPhysicalContext["publishArtifact"]>[0]) {
  const terminal = {
    key: published.line.key, request_digest: published.line.requestDigest, lineage: grant.lineage,
    ordinal: published.attemptOrdinal, raw_json: published.rawJson, admitted: published.admitted,
    outcome: published.outcome, finish_reason: published.finishReason,
    ...(published.usage === undefined ? {} : { usage: published.usage })
  };
  publishBytesExclusiveDurable({ destination: terminalPath(root, published.line.key),
    bytes: Buffer.from(JSON.stringify(terminal)), ownerIdentity: grant.lineage, temporaryDirectory: root, allowExistingExact: true });
}
