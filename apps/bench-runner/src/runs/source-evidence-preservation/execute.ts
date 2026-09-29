import { createHash } from "node:crypto";
import { refuseRecallCampaignLiveExtraction } from "@do-soul/alaya-core";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { createSemanticProviderHttpExtractor } from "../compile-seed/http/semantic-provider-http.js";
import { assertAttemptInputWithinReceiptLimit } from "../extraction/authority/receipt-limits.js";
import { acquireExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import { SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME } from "../provider-request/request-binding.js";
import {
  executeProviderRequestLine,
  replayExistingProviderRequestRaws,
  type ProviderRequestDispatchContext,
  type ProviderRequestLine,
  type ProviderRequestPhysicalContext
} from "../provider-request/execution.js";
import {
  interpretSourceEvidencePreservationDecoded, settleSourceEvidencePreservationDelivery,
  type SourceEvidencePreservationAssessed, type SourceEvidencePreservationDelivery,
  type SourceEvidencePreservationOutcome
} from "./assess.js";
import {
  assertSourceEvidencePreservationExecutionScope,
  buildSourceEvidencePreservationPreflight,
  inspectSourceEvidencePreservationExecutionScope,
  verifySourceEvidencePreservationAuthority,
  type SourceEvidencePreservationAuthority
} from "./authority.js";
import {
  SOURCE_EVIDENCE_PRESERVATION_KIND,
  materializeSourceEvidencePreservationLines,
  sourceEvidencePreservationRequestBinding,
  type SourceEvidencePreservationLine,
  type SourceEvidencePreservationWorkset
} from "./input.js";
import {
  SourceEvidencePreservationIdentityError,
  assertPreservationRawReservation,
  hasAdmittedPreservationOutcome,
  hasVerifiedPreservationCompletion,
  openSourceEvidencePreservationAttemptLedger,
  preservationOutcomeStatus,
  readSourceEvidencePreservationAttemptState,
  sourceEvidencePreservationLookup,
  writeSourceEvidencePreservationShard, type SourceEvidencePreservationShard
} from "./persist.js";

export type SourceEvidencePreservationResultRow = Readonly<{
  line: SourceEvidencePreservationLine;
  shard?: SourceEvidencePreservationShard;
  status: string;
  assessment?: SourceEvidencePreservationAssessed;
  delivery?: SourceEvidencePreservationDelivery;
}>;

export function prepareSourceEvidencePreservation(
  workset: SourceEvidencePreservationWorkset, cacheRoot: string, maxOutputTokens: number
) {
  const lines = materializeSourceEvidencePreservationLines(workset, maxOutputTokens);
  const cachedKeys = new Set<string>();
  for (const line of lines) {
    const state = readSourceEvidencePreservationAttemptState(
      cacheRoot, line.key, sourceEvidencePreservationLookup(workset, line, maxOutputTokens)
    );
    if (state.shard !== undefined) {
      if (state.status !== "settled") {
        throw new AlayaError(
          "CONFLICT",
          `evidence preservation ${line.key} requires fill recovery with its existing authority before preflight`
        );
      }
      replayCachedPreservationShard(line, state.shard, workset.request_profile);
      cachedKeys.add(line.key);
    }
  }
  return buildSourceEvidencePreservationPreflight({
    model: workset.model,
    request_profile: workset.request_profile,
    maxOutputTokens,
    lines,
    cachedKeys,
    executionScope: inspectSourceEvidencePreservationExecutionScope(cacheRoot)
  });
}

export async function executeSourceEvidencePreservationFill(input: Readonly<{
  workset: SourceEvidencePreservationWorkset;
  cacheRoot: string;
  authority: SourceEvidencePreservationAuthority;
  config: CompileSeedExtractionConfig;
  mode?: "execute" | "recover";
  extractor?: ReturnType<typeof createSemanticProviderHttpExtractor>;
}>) {
  refuseRecallCampaignLiveExtraction("extraction_write");
  const authority = verifySourceEvidencePreservationAuthority(input.authority);
  assertSourceEvidencePreservationExecutionScope(authority.execution_scope, input.cacheRoot);
  input = { ...input, authority, cacheRoot: authority.execution_scope.execution_root_path };
  if (authority.model !== input.workset.model || authority.request_profile !== input.workset.request_profile) {
    throw new AlayaError("CONFLICT", "evidence preservation authority does not bind this workset");
  }
  const maxOutputTokens = authority.limits.max_output_tokens;
  const lines = materializeSourceEvidencePreservationLines(input.workset, maxOutputTokens);
  assertAuthorizedPreservationRequest(input, lines, maxOutputTokens);
  const authorized = new Set(authority.keys);
  const dispatch: SourceEvidencePreservationLine[] = [];
  const retainedLines: SourceEvidencePreservationLine[] = [];
  let cacheHits = 0;
  for (const line of lines) {
    const existing = readSourceEvidencePreservationAttemptState(
      input.cacheRoot, line.key, sourceEvidencePreservationLookup(input.workset, line, maxOutputTokens)
    ).shard;
    if (existing !== undefined) {
      replayCachedPreservationShard(line, existing, input.workset.request_profile);
      cacheHits += 1;
      if (authorized.has(line.key)) retainedLines.push(line);
      continue;
    }
    if (!authorized.has(line.key)) continue;
    dispatch.push(line);
  }
  if (input.mode !== "recover" && dispatch.length > 0 && authority.limits.maximum_attempts === 0) {
    throw new AlayaError("CONFLICT", "evidence preservation authority has no remaining provider attempt capacity");
  }
  if (dispatch.length === 0 && retainedLines.length === 0) {
    return summarize(input, cacheHits, 0, 0);
  }
  const lease = acquireExtractionCacheWriteLease(input.cacheRoot);
  try {
    assertSourceEvidencePreservationExecutionScope(authority.execution_scope, input.cacheRoot, lease);
    input = { ...input, cacheRoot: lease.stableRootPath };
    const ledger = openSourceEvidencePreservationAttemptLedger({
      cacheRoot: input.cacheRoot, authority, writeLease: lease
    });
    if (input.mode === "recover") {
      const context = physicalContext(input, lines, ledger);
      for (const line of retainedLines) replayExistingProviderRequestRaws(context, toProviderLine(line));
      let newlyAdmitted = 0;
      for (const line of dispatch) {
        const replayed = replayExistingProviderRequestRaws(context, toProviderLine(line));
        if (replayed.done && replayed.admitted) newlyAdmitted += 1;
      }
      return summarize(input, cacheHits, newlyAdmitted, 0);
    }
    for (const line of retainedLines) {
      if (!ledger.snapshot().pendingKeys.includes(line.key) &&
          !ledger.snapshot().unresolvedAttempts.some((item) => item.cacheKey === line.key)) continue;
      replayExistingProviderRequestRaws(physicalContext(input, lines, ledger), toProviderLine(line));
      if (ledger.snapshot().pendingKeys.includes(line.key) ||
          ledger.snapshot().unresolvedAttempts.some((item) => item.cacheKey === line.key)) {
        throw new SourceEvidencePreservationIdentityError(
          `retained preservation has unresolved attempt evidence: ${line.key}`
        );
      }
    }
    const extractor = dispatch.length === 0 ? undefined : input.extractor ??
      createSemanticProviderHttpExtractor(input.config, SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME);
    let newlyAdmitted = 0, attempts = 0;
    for (const line of dispatch) {
      assertAttemptInputWithinReceiptLimit(line.inputByteUpper, authority.price.maximum_input_tokens_per_attempt);
      const filled = await executeProviderRequestLine(
        dispatchContext(input, lines, ledger, lease, extractor!), toProviderLine(line)
      );
      attempts += filled.attempts;
      if (filled.admitted) newlyAdmitted += 1;
    }
    return summarize(input, cacheHits, newlyAdmitted, attempts);
  } finally {
    lease.release();
  }
}

export function readSourceEvidencePreservationResults(
  workset: SourceEvidencePreservationWorkset, cacheRoot: string, maxOutputTokens: number
): readonly SourceEvidencePreservationResultRow[] {
  const lines = materializeSourceEvidencePreservationLines(workset, maxOutputTokens);
  return lines.map((line): SourceEvidencePreservationResultRow => {
    const state = readSourceEvidencePreservationAttemptState(
      cacheRoot, line.key, sourceEvidencePreservationLookup(workset, line, maxOutputTokens)
    );
    const shard = state.shard;
    if (state.status !== "settled") {
      return {
        line, shard, status: state.status,
        ...(state.status === "transport_failure" ? { delivery: settleDelivery(line, { status: "transport_failure" }) } : {})
      };
    }
    if (shard === undefined) return { line, status: "unattempted" as const };
    replayCachedPreservationShard(line, shard, workset.request_profile);
    const recorded = preservationOutcomeStatus(shard);
    if (recorded === "transport_failure") {
      return { line, shard, status: "transport_failure", delivery: settleDelivery(line, { status: "transport_failure" }) };
    }
    if (!shouldInterpretPreservationShard(shard, recorded)) {
      return {
        line, shard, status: recorded,
        delivery: settleDelivery(line, recorded === "incomplete"
          ? { status: "incomplete", reason: "noncomplete" }
          : { status: "invalid", reason: "unusable_response" })
      };
    }
    const interpreted = interpretSourceEvidencePreservationDecoded(line, {
      rawJson: shard.raw_json, finishReason: shard.finish_reason ?? null
    }, workset.request_profile);
    if (hasAdmittedPreservationOutcome(shard)) {
      if (!interpreted.admitted || interpreted.outcome.status === "invalid" ||
          interpreted.outcome.status === "incomplete" || interpreted.outcome.status === "transport_failure" ||
          interpreted.outcome.status === "abstained") {
        throw new SourceEvidencePreservationIdentityError("cached preservation no longer admits");
      }
      return {
        line, shard, status: interpreted.outcome.status, assessment: interpreted.outcome,
        delivery: settleDelivery(line, interpreted.outcome)
      };
    }
    const status = !hasVerifiedPreservationCompletion(shard) || interpreted.outcome.status === "incomplete"
      ? "incomplete"
      : recorded === "abstained" ? "abstained"
      : recorded === "preserved" || recorded === "lost" || recorded === "unresolved" ? "invalid"
      : recorded !== "interpreted" ? recorded
      : "invalid";
    return { line, shard, status, delivery: settleDelivery(line, interpreted.outcome) };
  });
}

function shouldInterpretPreservationShard(
  shard: SourceEvidencePreservationShard, recorded: string
): boolean {
  if (recorded === "transport_failure") return false;
  if (typeof shard.outcome === "object" && shard.outcome !== null && "reason" in shard.outcome &&
      ["truncated_raw", "missing_response_body", "truncated_response_body", "unsupported_response_body"]
        .includes(String(shard.outcome.reason))) {
    return false;
  }
  return shard.raw_json.length > 0 || hasVerifiedPreservationCompletion(shard);
}

function settleDelivery(
  line: SourceEvidencePreservationLine, outcome: SourceEvidencePreservationOutcome
): SourceEvidencePreservationDelivery {
  return settleSourceEvidencePreservationDelivery({
    references: line.reference_originals,
    candidates: line.candidate_originals,
    outcome
  });
}

function summarize(
  input: Parameters<typeof executeSourceEvidencePreservationFill>[0],
  cacheHits: number, newlyAdmitted: number, attempts: number
) {
  const rows = readSourceEvidencePreservationResults(
    input.workset, input.cacheRoot, input.authority.limits.max_output_tokens
  );
  const count = (...statuses: readonly string[]) => rows.filter((row) => statuses.includes(row.status)).length;
  return {
    requested: rows.length,
    cache_hits: cacheHits,
    newly_admitted: newlyAdmitted,
    terminal_failures: count("transport_failure"),
    attempts,
    preserved: count("preserved"),
    lost: count("lost"),
    unresolved: count("unresolved"),
    abstained: count("abstained"),
    cached_invalid: rows.filter((row) => row.shard !== undefined &&
      ["invalid", "incomplete", "transport_failure"].includes(row.status)).length,
    unattempted: count("unattempted"),
    unknown: count("unknown"),
    pending: count("pending"),
    incomplete: count("incomplete"),
    rejected: count("invalid"),
    candidate_deliveries: rows.filter((row) => row.delivery?.delivery === "candidate").length,
    baseline_fallbacks: rows.filter((row) => row.delivery?.delivery === "baseline").length
  };
}

function assertAuthorizedPreservationRequest(
  input: Parameters<typeof executeSourceEvidencePreservationFill>[0],
  lines: readonly SourceEvidencePreservationLine[],
  maxOutputTokens: number
): void {
  if (input.config.model !== input.workset.model || input.config.requestProfile !== input.workset.request_profile) {
    throw new AlayaError("CONFLICT", "evidence preservation execution config differs from authorized model/profile");
  }
  const materialDigest = createHash("sha256").update(canonicalJson(lines.map((line) => ({
    key: line.key, material_digest: line.materialDigest
  })))).digest("hex");
  if (input.authority.material_digest !== materialDigest) {
    throw new AlayaError("CONFLICT", "evidence preservation authority does not bind this source materialization");
  }
  for (const line of lines) {
    const actual = sourceEvidencePreservationRequestBinding(input.config, {
      systemPrompt: line.systemPrompt,
      userPrompt: line.userPrompt,
      responseJsonSchema: line.responseJsonSchema,
      maxOutputTokens
    });
    if (actual.requestDigest !== line.requestDigest ||
        canonicalJson(actual.transportProvenance) !== canonicalJson(line.transportProvenance) ||
        canonicalJson(line.transportProvenance) !== canonicalJson(input.authority.transport_provenance)) {
      throw new AlayaError("CONFLICT", "evidence preservation actual HTTP request differs from authorized request");
    }
  }
}

function toProviderLine(line: SourceEvidencePreservationLine): ProviderRequestLine {
  return {
    key: line.key,
    kind: SOURCE_EVIDENCE_PRESERVATION_KIND,
    systemPrompt: line.systemPrompt,
    userPrompt: line.userPrompt,
    responseJsonSchema: line.responseJsonSchema,
    requestDigest: line.requestDigest,
    inputByteUpper: line.inputByteUpper
  };
}

function physicalContext(
  input: Parameters<typeof executeSourceEvidencePreservationFill>[0],
  lines: readonly SourceEvidencePreservationLine[],
  ledger: ReturnType<typeof openSourceEvidencePreservationAttemptLedger>,
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
        throw new SourceEvidencePreservationIdentityError(
          `evidence preservation raw key is not in the workset: ${raw.cache_key}`
        );
      }
      assertPreservationRawReservation(
        raw,
        ledger.snapshot(),
        sourceEvidencePreservationLookup(input.workset, line, input.authority.limits.max_output_tokens),
        line.key
      );
    },
    interpretDecoded: (providerLine, decoded) => {
      const line = byKey.get(providerLine.key);
      if (line === undefined) {
        throw new SourceEvidencePreservationIdentityError(
          `evidence preservation line is not in the workset: ${providerLine.key}`
        );
      }
      return interpretSourceEvidencePreservationDecoded(line, decoded, input.workset.request_profile);
    },
    publishArtifact: (published) => {
      const line = byKey.get(published.line.key);
      if (line === undefined) {
        throw new SourceEvidencePreservationIdentityError(
          `evidence preservation publish key is not in the workset: ${published.line.key}`
        );
      }
      writeSourceEvidencePreservationShard(input.cacheRoot, {
        contract: "source-evidence-preservation-cache-v1" as const,
        kind: SOURCE_EVIDENCE_PRESERVATION_KIND,
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
        material_digest: line.materialDigest,
        attempt_lineage_digest: input.authority.attempt_lineage_digest,
        ...(published.usage === undefined ? {} : { usage: published.usage })
      });
    }
  };
}

function dispatchContext(
  input: Parameters<typeof executeSourceEvidencePreservationFill>[0],
  lines: readonly SourceEvidencePreservationLine[],
  ledger: ReturnType<typeof openSourceEvidencePreservationAttemptLedger>,
  writeLease: ReturnType<typeof acquireExtractionCacheWriteLease>,
  extractor: ReturnType<typeof createSemanticProviderHttpExtractor>
): ProviderRequestDispatchContext {
  return {
    ...physicalContext(input, lines, ledger),
    writeLease,
    extractor,
    config: input.config,
    suppliedExtractor: input.extractor !== undefined,
    assertScope: () => {
      assertSourceEvidencePreservationExecutionScope(input.authority.execution_scope, input.cacheRoot, writeLease);
    }
  };
}

function replayCachedPreservationShard(
  line: SourceEvidencePreservationLine,
  shard: Parameters<typeof preservationOutcomeStatus>[0],
  requestProfile: string
): void {
  const recorded = preservationOutcomeStatus(shard);
  if (!shouldInterpretPreservationShard(shard, recorded)) {
    if (shard.admitted) {
      throw new SourceEvidencePreservationIdentityError(`evidence preservation cache identity mismatch: ${shard.cache_key}`);
    }
    return;
  }
  const interpreted = interpretSourceEvidencePreservationDecoded(line, {
    rawJson: shard.raw_json, finishReason: shard.finish_reason ?? null
  }, requestProfile);
  if (shard.admitted || recorded === "preserved" || recorded === "lost" || recorded === "unresolved") {
    if (interpreted.classified !== "interpreted" ||
        interpreted.outcome.status !== recorded && shard.admitted) {
      throw new SourceEvidencePreservationIdentityError(`evidence preservation cache identity mismatch: ${shard.cache_key}`);
    }
    return;
  }
  if (recorded === "abstained" && interpreted.classified !== "abstained") {
    throw new SourceEvidencePreservationIdentityError(`evidence preservation cache identity mismatch: ${shard.cache_key}`);
  }
  if ((recorded === "invalid" || recorded === "incomplete") && interpreted.admitted) {
    throw new SourceEvidencePreservationIdentityError(`evidence preservation cache identity mismatch: ${shard.cache_key}`);
  }
}

export type { SourceEvidencePreservationDelivery, SourceEvidencePreservationOutcome };
