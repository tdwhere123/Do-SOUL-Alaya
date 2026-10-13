import { createHash } from "node:crypto";
import { refuseRecallCampaignLiveExtraction } from "@do-soul/alaya-core";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { createSemanticProviderHttpExtractor } from "../compile-seed/http/semantic-provider-http.js";
import { assertAttemptInputWithinReceiptLimit } from "../extraction/authority/receipt-limits.js";
import { acquireExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import { PAGE_SUPPORT_COMPARISON_SCHEMA_NAME } from "../provider-request/request-binding.js";
import {
  executeProviderRequestLine,
  replayExistingProviderRequestRaws,
  type ProviderRequestDispatchContext,
  type ProviderRequestLine,
  type ProviderRequestPhysicalContext
} from "../provider-request/execution.js";
import {
  interpretPageSupportComparisonDecoded,
  type PageSupportAssessed, type PageSupportComparisonOutcome
} from "./assess.js";
import {
  assertPageSupportComparisonExecutionRoot,
  buildPageSupportComparisonPreflight,
  inspectPageSupportComparisonExecutionScope,
  verifyPageSupportComparisonAuthority,
  type PageSupportComparisonAuthority
} from "./authority.js";
import {
  PAGE_SUPPORT_COMPARISON_KIND,
  materializePageSupportComparisonLines,
  pageSupportComparisonRequestBinding,
  type PageSupportComparisonLine,
  type PageSupportComparisonWorkset
} from "./input.js";
import {
  PageSupportComparisonIdentityError,
  buildPageSupportComparisonShard,
  assertComparisonRawReservation,
  comparisonOutcomeStatus,
  hasAdmittedComparisonOutcome,
  hasVerifiedComparisonCompletion,
  openPageSupportComparisonAttemptLedger,
  pageSupportComparisonLookup,
  readPageSupportComparisonAttemptState,
  writePageSupportComparisonShard, type PageSupportComparisonShard
} from "./persist.js";

export type PageSupportComparisonResultRow = Readonly<{
  line: PageSupportComparisonLine;
  shard?: PageSupportComparisonShard;
  status: string;
  assessment?: PageSupportAssessed;
}>;

export function preparePageSupportComparison(
  workset: PageSupportComparisonWorkset, cacheRoot: string, maxOutputTokens: number
) {
  const lines = materializePageSupportComparisonLines(workset, maxOutputTokens);
  const cachedKeys = new Set<string>();
  for (const line of lines) {
    const state = readPageSupportComparisonAttemptState(
      cacheRoot, line.key, pageSupportComparisonLookup(workset, line, maxOutputTokens)
    );
    if (state.shard !== undefined) {
      if (state.status !== "settled") {
        throw new AlayaError(
          "CONFLICT",
          `page-support comparison ${line.key} requires fill recovery with its existing authority before preflight`
        );
      }
      replayCachedComparisonShard(line, state.shard, workset.request_profile);
      cachedKeys.add(line.key);
    }
  }
  return buildPageSupportComparisonPreflight({
    model: workset.model,
    request_profile: workset.request_profile,
    maxOutputTokens,
    lines,
    cachedKeys,
    executionScope: inspectPageSupportComparisonExecutionScope(cacheRoot)
  });
}

export async function executePageSupportComparisonFill(input: Readonly<{
  workset: PageSupportComparisonWorkset;
  cacheRoot: string;
  authority: PageSupportComparisonAuthority;
  config: CompileSeedExtractionConfig;
  mode?: "execute" | "recover";
  extractor?: ReturnType<typeof createSemanticProviderHttpExtractor>;
  /** Called after a key's execution returns, before reserving any following key. */
  continueAfterResult?: (key: string) => boolean;
}>) {
  refuseRecallCampaignLiveExtraction("extraction_write");
  const authority = verifyPageSupportComparisonAuthority(input.authority);
  assertPageSupportComparisonExecutionRoot(authority.execution_scope, input.cacheRoot);
  input = { ...input, authority, cacheRoot: authority.execution_scope.execution_root_path };
  if (authority.model !== input.workset.model || authority.request_profile !== input.workset.request_profile) {
    throw new AlayaError("CONFLICT", "page-support comparison authority does not bind this workset");
  }
  const maxOutputTokens = authority.limits.max_output_tokens;
  const lines = materializePageSupportComparisonLines(input.workset, maxOutputTokens);
  assertAuthorizedComparisonRequest(input, lines, maxOutputTokens);
  const authorized = new Set(authority.keys);
  const dispatch: PageSupportComparisonLine[] = [];
  const retainedLines: PageSupportComparisonLine[] = [];
  let cacheHits = 0;
  for (const line of lines) {
    const existing = readPageSupportComparisonAttemptState(
      input.cacheRoot, line.key, pageSupportComparisonLookup(input.workset, line, maxOutputTokens)
    ).shard;
    if (existing !== undefined) {
      replayCachedComparisonShard(line, existing, input.workset.request_profile);
      cacheHits += 1;
      if (authorized.has(line.key)) retainedLines.push(line);
      continue;
    }
    if (!authorized.has(line.key)) continue;
    dispatch.push(line);
  }
  if (input.mode !== "recover" && dispatch.length > 0 && authority.limits.maximum_attempts === 0) {
    throw new AlayaError("CONFLICT", "page-support comparison authority has no remaining provider attempt capacity");
  }
  if (dispatch.length === 0 && retainedLines.length === 0) {
    return summarize(input, cacheHits, 0, 0);
  }
  const lease = acquireExtractionCacheWriteLease(input.cacheRoot);
  try {
    input = { ...input, cacheRoot: lease.stableRootPath };
    // The ledger owner checks source compatibility once, before this operation can mutate it.
    const ledger = openPageSupportComparisonAttemptLedger({
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
        throw new PageSupportComparisonIdentityError(
          `retained page-support comparison has unresolved attempt evidence: ${line.key}`
        );
      }
    }
    const extractor = dispatch.length === 0 ? undefined : input.extractor ??
      createSemanticProviderHttpExtractor(input.config, PAGE_SUPPORT_COMPARISON_SCHEMA_NAME);
    let newlyAdmitted = 0, attempts = 0;
    for (const line of dispatch) {
      assertAttemptInputWithinReceiptLimit(line.inputByteUpper, authority.price.maximum_input_tokens_per_attempt);
      const filled = await executeProviderRequestLine(
        dispatchContext(input, lines, ledger, lease, extractor!), toProviderLine(line)
      );
      attempts += filled.attempts;
      if (filled.admitted) newlyAdmitted += 1;
      if (input.continueAfterResult !== undefined && !input.continueAfterResult(line.key)) break;
    }
    return summarize(input, cacheHits, newlyAdmitted, attempts);
  } finally {
    lease.release();
  }
}

export function readPageSupportComparisonResults(
  workset: PageSupportComparisonWorkset, cacheRoot: string, maxOutputTokens: number
): readonly PageSupportComparisonResultRow[] {
  const lines = materializePageSupportComparisonLines(workset, maxOutputTokens);
  return lines.map((line): PageSupportComparisonResultRow => {
    const state = readPageSupportComparisonAttemptState(
      cacheRoot, line.key, pageSupportComparisonLookup(workset, line, maxOutputTokens)
    );
    const shard = state.shard;
    if (state.status !== "settled") return { line, shard, status: state.status };
    if (shard === undefined) return { line, status: "unattempted" as const };
    return pageSupportComparisonResultFromShard(line, shard, workset.request_profile);
  });
}

export function pageSupportComparisonResultFromShard(
  line: PageSupportComparisonLine, shard: PageSupportComparisonShard, requestProfile: string
): PageSupportComparisonResultRow {
  replayCachedComparisonShard(line, shard, requestProfile);
  if (!hasAdmittedComparisonOutcome(shard)) {
    const outcome = comparisonOutcomeStatus(shard);
    const status = outcome === "transport_failure" ? outcome
      : !hasVerifiedComparisonCompletion(shard) ||
        typeof shard.outcome === "object" && shard.outcome !== null &&
        "reason" in shard.outcome && ["truncated_raw", "missing_response_body", "truncated_response_body",
          "unsupported_response_body", "noncomplete"].includes(String(shard.outcome.reason))
        ? "incomplete"
        : outcome === "abstained" ? "abstained"
        : outcome !== "assessed" ? outcome
        : "invalid";
    return { line, shard, status };
  }
  const interpreted = interpretPageSupportComparisonDecoded(line, {
    rawJson: shard.raw_json, finishReason: shard.finish_reason ?? null
  }, requestProfile);
  if (!interpreted.admitted || interpreted.outcome.status !== "assessed") {
    throw new PageSupportComparisonIdentityError("cached page-support comparison no longer admits");
  }
  return { line, shard, status: "assessed", assessment: interpreted.outcome };
}

function summarize(
  input: Parameters<typeof executePageSupportComparisonFill>[0],
  cacheHits: number, newlyAdmitted: number, attempts: number
) {
  const rows = readPageSupportComparisonResults(
    input.workset, input.cacheRoot, input.authority.limits.max_output_tokens
  );
  const count = (...statuses: readonly string[]) => rows.filter((row) => statuses.includes(row.status)).length;
  return {
    requested: rows.length,
    cache_hits: cacheHits,
    newly_admitted: newlyAdmitted,
    terminal_failures: count("transport_failure"),
    attempts,
    assessed: count("assessed"),
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

export function assertAuthorizedComparisonRequest(
  input: Pick<Parameters<typeof executePageSupportComparisonFill>[0], "config" | "workset" | "authority">,
  lines: readonly PageSupportComparisonLine[],
  maxOutputTokens: number
): void {
  if (input.config.model !== input.workset.model || input.config.requestProfile !== input.workset.request_profile) {
    throw new AlayaError("CONFLICT", "page-support comparison execution config differs from authorized model/profile");
  }
  const materialDigest = createHash("sha256").update(canonicalJson(lines.map((line) => ({
    key: line.key, material_digest: line.materialDigest
  })))).digest("hex");
  if (input.authority.material_digest !== materialDigest) {
    throw new AlayaError("CONFLICT", "page-support comparison authority does not bind this source materialization");
  }
  for (const line of lines) {
    const actual = pageSupportComparisonRequestBinding(input.config, {
      systemPrompt: line.systemPrompt,
      userPrompt: line.userPrompt,
      responseJsonSchema: line.responseJsonSchema,
      maxOutputTokens
    });
    if (actual.requestDigest !== line.requestDigest ||
        canonicalJson(actual.transportProvenance) !== canonicalJson(line.transportProvenance) ||
        canonicalJson(line.transportProvenance) !== canonicalJson(input.authority.transport_provenance)) {
      throw new AlayaError("CONFLICT", "page-support comparison actual HTTP request differs from authorized request");
    }
  }
}

export function toProviderLine(line: PageSupportComparisonLine): ProviderRequestLine {
  return {
    key: line.key,
    kind: PAGE_SUPPORT_COMPARISON_KIND,
    systemPrompt: line.systemPrompt,
    userPrompt: line.userPrompt,
    responseJsonSchema: line.responseJsonSchema,
    requestDigest: line.requestDigest,
    inputByteUpper: line.inputByteUpper
  };
}

function physicalContext(
  input: Parameters<typeof executePageSupportComparisonFill>[0],
  lines: readonly PageSupportComparisonLine[],
  ledger: ReturnType<typeof openPageSupportComparisonAttemptLedger>,
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
        throw new PageSupportComparisonIdentityError(
          `page-support comparison raw key is not in the workset: ${raw.cache_key}`
        );
      }
      assertComparisonRawReservation(
        raw,
        ledger.snapshot(),
        pageSupportComparisonLookup(input.workset, line, input.authority.limits.max_output_tokens),
        line.key
      );
    },
    interpretDecoded: (providerLine, decoded) => {
      const line = byKey.get(providerLine.key);
      if (line === undefined) {
        throw new PageSupportComparisonIdentityError(
          `page-support comparison line is not in the workset: ${providerLine.key}`
        );
      }
      return interpretPageSupportComparisonDecoded(line, decoded, input.workset.request_profile);
    },
    publishArtifact: (published) => {
      const line = byKey.get(published.line.key);
      if (line === undefined) {
        throw new PageSupportComparisonIdentityError(
          `page-support comparison publish key is not in the workset: ${published.line.key}`
        );
      }
      writePageSupportComparisonShard(input.cacheRoot, buildPageSupportComparisonShard({ line, published,
        model: input.workset.model, requestProfile: input.workset.request_profile,
        maxOutputTokens: input.authority.limits.max_output_tokens,
        attemptLineageDigest: input.authority.attempt_lineage_digest }));
    }
  };
}

function dispatchContext(
  input: Parameters<typeof executePageSupportComparisonFill>[0],
  lines: readonly PageSupportComparisonLine[],
  ledger: ReturnType<typeof openPageSupportComparisonAttemptLedger>,
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
      assertPageSupportComparisonExecutionRoot(input.authority.execution_scope, input.cacheRoot, writeLease);
    }
  };
}

function replayCachedComparisonShard(
  line: PageSupportComparisonLine,
  shard: Parameters<typeof comparisonOutcomeStatus>[0],
  requestProfile: string
): void {
  if (typeof shard.outcome === "object" && shard.outcome !== null && "reason" in shard.outcome &&
      ["missing_response_body", "truncated_response_body", "unsupported_response_body", "noncomplete"]
        .includes(String(shard.outcome.reason))) {
    if (shard.admitted) {
      throw new PageSupportComparisonIdentityError(
        `page-support comparison cache identity mismatch: ${shard.cache_key}`
      );
    }
    return;
  }
  const interpreted = interpretPageSupportComparisonDecoded(line, {
    rawJson: shard.raw_json, finishReason: shard.finish_reason ?? null
  }, requestProfile);
  const recorded = comparisonOutcomeStatus(shard);
  if (shard.admitted || recorded === "assessed") {
    if (interpreted.classified !== "interpreted" || interpreted.outcome.status !== "assessed") {
      throw new PageSupportComparisonIdentityError(
        `page-support comparison cache identity mismatch: ${shard.cache_key}`
      );
    }
    return;
  }
  if (recorded === "abstained" && interpreted.classified !== "abstained") {
    throw new PageSupportComparisonIdentityError(
      `page-support comparison cache identity mismatch: ${shard.cache_key}`
    );
  }
  if ((recorded === "invalid" || recorded === "incomplete") && interpreted.admitted) {
    throw new PageSupportComparisonIdentityError(
      `page-support comparison cache identity mismatch: ${shard.cache_key}`
    );
  }
}

export type { PageSupportComparisonOutcome };
