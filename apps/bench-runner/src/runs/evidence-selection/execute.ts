import { createHash } from "node:crypto";
import { INPUT_NAVIGATION_POLICY } from "../source-access-diagnostic/input-condition-formation.js";
import { refuseRecallCampaignLiveExtraction } from "@do-soul/alaya-core";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { createSemanticProviderHttpExtractor } from "../compile-seed/http/semantic-provider-http.js";
import { assertAttemptInputWithinReceiptLimit } from "../extraction/authority/receipt-limits.js";
import { acquireExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import { SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME } from "../provider-request/request-binding.js";
import {
  executeProviderRequestLine,
  replayExistingProviderRequestRaws,
  type ProviderRequestDispatchContext,
  type ProviderRequestLine,
  type ProviderRequestPhysicalContext
} from "../provider-request/execution.js";
import {
  assertEvidenceSelectionExecutionRoot,
  buildEvidenceSelectionPreflight,
  inspectEvidenceSelectionExecutionScope,
  verifyEvidenceSelectionAuthority,
  type EvidenceSelectionAuthority
} from "./authority.js";
import {
  EvidenceSelectionIdentityError,
  hasAdmittedSelectionOutcome,
  hasVerifiedSelectionCompletion,
  selectionOutcomeStatus,
  writeEvidenceSelectionShard
} from "./artifact.js";
import {
  assertSelectionRawReservation,
  evidenceSelectionLookup,
  openEvidenceSelectionAttemptLedger,
  readEvidenceSelectionAttemptState
} from "./attempt.js";
import {
  EVIDENCE_SELECTION_KIND,
  evidenceSelectionRequestBinding,
  interpretEvidenceSelectionDecoded,
  materializeEvidenceSelectionLines,
  type EvidenceSelectionBoundEntry,
  type EvidenceSelectionLine,
  type EvidenceSelectionOutcome,
  type EvidenceSelectionWorkset
} from "./input.js";

export function prepareEvidenceSelection(
  workset: EvidenceSelectionWorkset, cacheRoot: string, maxOutputTokens: number
) {
  const lines = materializeEvidenceSelectionLines(workset, maxOutputTokens);
  const cachedKeys = new Set<string>();
  for (const line of lines) {
    const state = readEvidenceSelectionAttemptState(
      cacheRoot, line.key, evidenceSelectionLookup(workset, line, maxOutputTokens)
    );
    if (state.shard !== undefined) {
      if (state.status !== "settled") {
        throw new AlayaError(
          "CONFLICT",
          `evidence selection ${line.key} requires fill recovery with its existing authority before preflight`
        );
      }
      replayCachedSelectionShard(line, state.shard, workset.request_profile);
      cachedKeys.add(line.key);
    }
  }
  return buildEvidenceSelectionPreflight({
    model: workset.model,
    request_profile: workset.request_profile,
    maxOutputTokens,
    lines,
    cachedKeys,
    executionScope: inspectEvidenceSelectionExecutionScope(cacheRoot)
  });
}

export async function executeEvidenceSelectionFill(input: Readonly<{
  workset: EvidenceSelectionWorkset;
  cacheRoot: string;
  authority: EvidenceSelectionAuthority;
  config: CompileSeedExtractionConfig;
  /** Private monotonic phase deadline, never part of request/cache identity. */
  phaseDeadlineMs?: number;
  extractor?: ReturnType<typeof createSemanticProviderHttpExtractor>;
  /** Called after a key's execution returns, before reserving any following key. */
  continueAfterResult?: (key: string) => boolean;
}>) {
  const started = performance.now();
  // Authorization, transport construction, persistence and readback must share this capture.
  // Readonly types do not prevent the caller from mutating an object while readiness awaits.
  input = { ...input, workset: structuredClone(input.workset), config: structuredClone(input.config) };
  refuseRecallCampaignLiveExtraction("extraction_write");
  const authority = verifyEvidenceSelectionAuthority(input.authority);
  assertEvidenceSelectionExecutionRoot(authority.execution_scope, input.cacheRoot);
  input = { ...input, authority, cacheRoot: authority.execution_scope.execution_root_path };
  if (authority.model !== input.workset.model || authority.request_profile !== input.workset.request_profile) {
    throw new AlayaError("CONFLICT", "evidence selection authority does not bind this workset");
  }
  const maxOutputTokens = authority.limits.max_output_tokens;
  const lines = materializeEvidenceSelectionLines(input.workset, maxOutputTokens);
  assertAuthorizedSelectionRequest(input, lines, maxOutputTokens);
  const inputNavigation = input.workset.request_policy === INPUT_NAVIGATION_POLICY;
  if (inputNavigation && (lines.length > 8 || authority.limits.maximum_attempts > 8 || maxOutputTokens > 8192
    || lines.some(line => line.inputByteUpper > 16 * 1024)
    || input.workset.model !== "step-3.5-flash-2603" || input.workset.provider_url !== "https://api.stepfun.com/v1"
    || input.workset.request_profile !== "step-3.5-2603-low-json-schema-v1"
    || authority.price.estimated_upper_usd > 0.25 * authority.price.quote_basis!.policy_usd_per_cny)) {
    throw new AlayaError("CONFLICT", "input navigation exceeds its finite Step task bounds");
  }
  const phaseDeadlineMs = inputNavigation
    ? Math.min(input.phaseDeadlineMs ?? Infinity, started + 45 * 60_000) : input.phaseDeadlineMs;
  if (phaseDeadlineMs !== undefined) {
    if (!Number.isFinite(phaseDeadlineMs)) throw new AlayaError("VALIDATION", "invalid provider phase deadline");
    input = { ...input, phaseDeadlineMs };
  }
  const authorized = new Set(authority.keys);
  const dispatch: EvidenceSelectionLine[] = [];
  const retainedLines: EvidenceSelectionLine[] = [];
  let cacheHits = 0, stoppedByRetainedNavigation = false;
  for (const line of lines) {
    const existing = readEvidenceSelectionAttemptState(
      input.cacheRoot, line.key, evidenceSelectionLookup(input.workset, line, maxOutputTokens)
    ).shard;
    if (existing !== undefined) {
      replayCachedSelectionShard(line, existing, input.workset.request_profile);
      if (inputNavigation && (!hasAdmittedSelectionOutcome(existing) || existing.usage === undefined
        || existing.usage.inputTokens > line.inputByteUpper)) stoppedByRetainedNavigation = true;
      cacheHits += 1;
      if (authorized.has(line.key)) retainedLines.push(line);
      continue;
    }
    if (!authorized.has(line.key)) continue;
    dispatch.push(line);
  }
  if (dispatch.length > 0 && authority.limits.maximum_attempts === 0) {
    throw new AlayaError("CONFLICT", "evidence selection authority has no remaining provider attempt capacity");
  }
  if (dispatch.length === 0 && retainedLines.length === 0) {
    return summarize(input, cacheHits, 0, 0);
  }
  const lease = acquireExtractionCacheWriteLease(input.cacheRoot);
  try {
    input = { ...input, cacheRoot: lease.stableRootPath };
    // The ledger owner checks source compatibility once, before this operation can mutate it.
    const ledger = openEvidenceSelectionAttemptLedger({
      cacheRoot: input.cacheRoot, authority, writeLease: lease
    });
    for (const line of retainedLines) {
      if (!ledger.snapshot().pendingKeys.includes(line.key) &&
          !ledger.snapshot().unresolvedAttempts.some((item) => item.cacheKey === line.key)) continue;
      replayExistingProviderRequestRaws(physicalContext(input, lines, ledger), toProviderLine(line));
      if (ledger.snapshot().pendingKeys.includes(line.key) ||
          ledger.snapshot().unresolvedAttempts.some((item) => item.cacheKey === line.key)) {
        throw new EvidenceSelectionIdentityError(`retained selection has unresolved attempt evidence: ${line.key}`);
      }
    }
    // A settled decline/failure is not a cache hit that authorizes later keys on re-entry.
    if (stoppedByRetainedNavigation) return summarize(input, cacheHits, 0, 0);
    const extractor = dispatch.length === 0 ? undefined : input.extractor ??
      createSemanticProviderHttpExtractor(input.config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME);
    let newlyAdmitted = 0, attempts = 0;
    for (const line of dispatch) {
      if (phaseDeadlineMs !== undefined && phaseDeadlineMs - performance.now() < 1) break;
      assertAttemptInputWithinReceiptLimit(line.inputByteUpper, authority.price.maximum_input_tokens_per_attempt);
      const filled = await executeProviderRequestLine(
        dispatchContext(input, lines, ledger, lease, extractor!), toProviderLine(line)
      );
      attempts += filled.attempts;
      if (filled.admitted) newlyAdmitted += 1;
      if (inputNavigation) {
        const retained = readEvidenceSelectionAttemptState(input.cacheRoot, line.key,
          evidenceSelectionLookup(input.workset, line, maxOutputTokens));
        if (!filled.admitted || filled.classified !== "interpreted" || retained.status !== "settled"
          || retained.shard?.usage === undefined || retained.shard.usage.inputTokens > line.inputByteUpper) break;
      }
      if (input.continueAfterResult !== undefined && !input.continueAfterResult(line.key)) break;
    }
    return summarize(input, cacheHits, newlyAdmitted, attempts);
  } finally {
    lease.release();
  }
}

export function readEvidenceSelectionResults(
  workset: EvidenceSelectionWorkset, cacheRoot: string, maxOutputTokens: number
) {
  const lines = materializeEvidenceSelectionLines(workset, maxOutputTokens);
  return lines.map((line) => {
    const state = readEvidenceSelectionAttemptState(
      cacheRoot, line.key, evidenceSelectionLookup(workset, line, maxOutputTokens)
    );
    const shard = state.shard;
    if (state.status !== "settled") return { line, shard, status: state.status };
    if (shard === undefined) return { line, status: "unattempted" as const };
    replayCachedSelectionShard(line, shard, workset.request_profile);
    if (!hasAdmittedSelectionOutcome(shard)) {
      const outcome = selectionOutcomeStatus(shard);
      const status = outcome === "transport_failure" ? outcome
        : !hasVerifiedSelectionCompletion(shard) ||
          typeof shard.outcome === "object" && shard.outcome !== null &&
          "reason" in shard.outcome && ["truncated_raw", "missing_response_body", "truncated_response_body",
            "unsupported_response_body", "noncomplete"].includes(String(shard.outcome.reason))
          ? "incomplete"
          : outcome === "abstained" ? "abstained"
          : outcome !== "interpreted" ? outcome
          : "invalid";
      return { line, shard, status };
    }
    const interpreted = interpretEvidenceSelectionDecoded(line, {
      rawJson: shard.raw_json, finishReason: shard.finish_reason ?? null
    }, workset.request_profile);
    if (!interpreted.admitted || interpreted.outcome.status !== "interpreted") {
      throw new EvidenceSelectionIdentityError("cached selection no longer admits");
    }
    return {
      line,
      shard,
      status: "interpreted" as const,
      selection: {
        selected: interpreted.outcome.selected,
        unresolved: interpreted.outcome.unresolved
      } satisfies {
        selected: readonly EvidenceSelectionBoundEntry[];
        unresolved: readonly string[];
      }
    };
  });
}

function summarize(
  input: Parameters<typeof executeEvidenceSelectionFill>[0],
  cacheHits: number, newlyAdmitted: number, attempts: number
) {
  const rows = readEvidenceSelectionResults(input.workset, input.cacheRoot, input.authority.limits.max_output_tokens);
  const count = (...statuses: readonly string[]) => rows.filter((row) => statuses.includes(row.status)).length;
  return {
    requested: rows.length,
    cache_hits: cacheHits,
    newly_admitted: newlyAdmitted,
    terminal_failures: count("transport_failure"),
    attempts,
    interpreted: count("interpreted"),
    abstained: count("abstained"),
    cached_invalid: rows.filter((row) => row.shard !== undefined &&
      ["invalid", "incomplete", "transport_failure"].includes(row.status)).length,
    unattempted: count("unattempted"),
    unknown: count("unknown"),
    pending: count("pending"),
    incomplete: count("incomplete"),
    rejected: count("invalid")
  };
}

function assertAuthorizedSelectionRequest(
  input: Parameters<typeof executeEvidenceSelectionFill>[0],
  lines: readonly EvidenceSelectionLine[],
  maxOutputTokens: number
): void {
  if (input.config.model !== input.workset.model || input.config.requestProfile !== input.workset.request_profile) {
    throw new AlayaError("CONFLICT", "evidence selection execution config differs from authorized model/profile");
  }
  const sourcesDigest = createHash("sha256").update(canonicalJson(lines.map((line) => ({
    key: line.key, sources_digest: line.sourcesDigest
  })))).digest("hex");
  if (input.authority.sources_digest !== sourcesDigest) {
    throw new AlayaError("CONFLICT", "evidence selection authority does not bind this source materialization");
  }
  for (const line of lines) {
    const actual = evidenceSelectionRequestBinding(input.config, {
      systemPrompt: line.systemPrompt,
      userPrompt: line.userPrompt,
      responseJsonSchema: line.responseJsonSchema,
      maxOutputTokens
    });
    if (actual.requestDigest !== line.requestDigest ||
        canonicalJson(actual.transportProvenance) !== canonicalJson(line.transportProvenance) ||
        canonicalJson(line.transportProvenance) !== canonicalJson(input.authority.transport_provenance)) {
      throw new AlayaError("CONFLICT", "evidence selection actual HTTP request differs from authorized request");
    }
  }
}

function toProviderLine(line: EvidenceSelectionLine): ProviderRequestLine {
  return {
    key: line.key,
    kind: EVIDENCE_SELECTION_KIND,
    systemPrompt: line.systemPrompt,
    userPrompt: line.userPrompt,
    responseJsonSchema: line.responseJsonSchema,
    requestDigest: line.requestDigest,
    inputByteUpper: line.inputByteUpper
  };
}

function physicalContext(
  input: Parameters<typeof executeEvidenceSelectionFill>[0],
  lines: readonly EvidenceSelectionLine[],
  ledger: ReturnType<typeof openEvidenceSelectionAttemptLedger>,
): ProviderRequestPhysicalContext {
  const byKey = new Map(lines.map((line) => [line.key, line]));
  return {
    cacheRoot: input.cacheRoot,
    model: input.workset.model,
    requestProfile: input.workset.request_profile,
    attemptLineageDigest: input.authority.attempt_lineage_digest,
    maxOutputTokens: input.authority.limits.max_output_tokens,
    maximumAttemptsPerKey: 1,
    ledger,
    assertReservation: (raw) => {
      const line = byKey.get(raw.cache_key);
      if (line === undefined) {
        throw new EvidenceSelectionIdentityError(`evidence selection raw key is not in the workset: ${raw.cache_key}`);
      }
      assertSelectionRawReservation(
        raw,
        ledger.snapshot(),
        evidenceSelectionLookup(input.workset, line, input.authority.limits.max_output_tokens),
        line.key
      );
    },
    interpretDecoded: (providerLine, decoded) => {
      const line = byKey.get(providerLine.key);
      if (line === undefined) {
        throw new EvidenceSelectionIdentityError(`evidence selection line is not in the workset: ${providerLine.key}`);
      }
      return interpretEvidenceSelectionDecoded(line, decoded, input.workset.request_profile);
    },
    publishArtifact: (published) => {
      const line = byKey.get(published.line.key);
      if (line === undefined) {
        throw new EvidenceSelectionIdentityError(`evidence selection publish key is not in the workset: ${published.line.key}`);
      }
      writeEvidenceSelectionShard(input.cacheRoot, {
        contract: "source-evidence-selection-cache-v1" as const,
        kind: EVIDENCE_SELECTION_KIND,
        cache_key: line.key,
        model: input.workset.model,
        request_profile: input.workset.request_profile,
        original_question: line.original_question,
        system_prompt: line.systemPrompt,
        user_prompt: line.userPrompt,
        raw_json: published.rawJson,
        outcome: published.outcome,
        admitted: published.admitted,
        attempt_ordinal: published.attemptOrdinal,
        extracted_at: new Date().toISOString(),
        finish_reason: published.finishReason,
        completion_witness: published.finishReason === null ? null : "finish_reason",
        raw_digest: createHash("sha256").update(published.rawJson, "utf8").digest("hex"),
        max_output_tokens: input.authority.limits.max_output_tokens,
        transport_provenance: line.transportProvenance,
        request_digest: line.requestDigest,
        sources_digest: line.sourcesDigest,
        attempt_lineage_digest: input.authority.attempt_lineage_digest,
        ...(published.usage === undefined ? {} : { usage: published.usage })
      });
    }
  };
}

function dispatchContext(
  input: Parameters<typeof executeEvidenceSelectionFill>[0],
  lines: readonly EvidenceSelectionLine[],
  ledger: ReturnType<typeof openEvidenceSelectionAttemptLedger>,
  writeLease: ReturnType<typeof acquireExtractionCacheWriteLease>,
  extractor: ReturnType<typeof createSemanticProviderHttpExtractor>
): ProviderRequestDispatchContext {
  return {
    ...physicalContext(input, lines, ledger),
    writeLease,
    extractor,
    config: input.config,
    suppliedExtractor: input.extractor !== undefined,
    ...(input.phaseDeadlineMs === undefined ? {} : { phaseDeadlineMs: input.phaseDeadlineMs }),
    assertScope: () => {
      assertEvidenceSelectionExecutionRoot(input.authority.execution_scope, input.cacheRoot, writeLease);
    }
  };
}

function replayCachedSelectionShard(
  line: EvidenceSelectionLine,
  shard: Parameters<typeof selectionOutcomeStatus>[0],
  requestProfile: string
): void {
  if (typeof shard.outcome === "object" && shard.outcome !== null && "reason" in shard.outcome &&
      ["missing_response_body", "truncated_response_body", "unsupported_response_body", "noncomplete"]
        .includes(String(shard.outcome.reason))) {
    if (shard.admitted) {
      throw new EvidenceSelectionIdentityError(`evidence selection cache identity mismatch: ${shard.cache_key}`);
    }
    return;
  }
  const interpreted = interpretEvidenceSelectionDecoded(line, {
    rawJson: shard.raw_json, finishReason: shard.finish_reason ?? null
  }, requestProfile);
  const recorded = selectionOutcomeStatus(shard);
  if (shard.admitted || recorded === "interpreted") {
    if (interpreted.classified !== "interpreted" || interpreted.outcome.status !== "interpreted") {
      throw new EvidenceSelectionIdentityError(`evidence selection cache identity mismatch: ${shard.cache_key}`);
    }
    return;
  }
  if (recorded === "abstained" && interpreted.classified !== "abstained") {
    throw new EvidenceSelectionIdentityError(`evidence selection cache identity mismatch: ${shard.cache_key}`);
  }
  if ((recorded === "invalid" || recorded === "incomplete") && interpreted.admitted) {
    throw new EvidenceSelectionIdentityError(`evidence selection cache identity mismatch: ${shard.cache_key}`);
  }
}

export type { EvidenceSelectionOutcome };
