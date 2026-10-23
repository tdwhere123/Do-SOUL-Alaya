import { resolve } from "node:path";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { refuseRecallCampaignLiveExtraction } from "@do-soul/alaya-core";
import type { CompileSeedExtractionConfig, BenchSignalExtractor } from "../compile-seed/compile-seed-types.js";
import { createSemanticProviderHttpExtractor } from "../compile-seed/http/semantic-provider-http.js";
import { bindSemanticProviderRequest } from "../provider-request/request-binding.js";
import { acquireExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import { executeProviderRequestLine, replayExistingProviderRequestRaws,
  type ProviderRequestPhysicalContext } from "../provider-request/execution.js";
import { readFrozenAnswerGrant, assertFrozenAnswerScope, assertFrozenAnswerRequests, type FrozenAnswerGrantPin } from "./authority.js";
import { FROZEN_ANSWER_KIND, materializeFrozenAnswers } from "./input.js";
import { openFrozenAnswerLedger, assertAnswerRaw, interpretFrozenAnswer, publishFrozenAnswer, readFrozenAnswerResult } from "./persist.js";

export type FrozenAnswerDependencies = Readonly<{
  loadConfig: () => CompileSeedExtractionConfig;
  createExtractor?: (config: CompileSeedExtractionConfig) => BenchSignalExtractor;
}>;

/** Consumes one externally issued study; no prepare/authorize/reset/renew mode. */
export async function consumeFrozenAnswers(input: Readonly<{ grantPin: FrozenAnswerGrantPin; mode: "execute" | "recover";
  abortSignal?: AbortSignal }>, dependencies: FrozenAnswerDependencies) {
  refuseRecallCampaignLiveExtraction("extraction_write");
  const pin = Object.freeze({ path: resolve(input.grantPin.path), sha256: input.grantPin.sha256 });
  const grant = readFrozenAnswerGrant(pin), mode = input.mode, abortSignal = input.abortSignal;
  const initial = assertFrozenAnswerScope(grant);
  const config: CompileSeedExtractionConfig = Object.freeze(structuredClone(mode === "recover"
    ? { model: grant.model, requestProfile: grant.request_profile, providerUrl: grant.provider_url, apiKey: null }
    : dependencies.loadConfig()) as CompileSeedExtractionConfig);
  if (config.model !== grant.model || config.requestProfile !== grant.request_profile || config.providerUrl !== grant.provider_url ||
    config.transportModel !== undefined || config.transportProviderUrl !== undefined) {
    throw new AlayaError("CONFLICT", "answer config differs from externally granted route");
  }
  const lines = materializeFrozenAnswers(resolve(grant.capture_root), config, grant.limits.max_output_tokens);
  assertFrozenAnswerRequests(grant, lines);
  const phaseDeadlineMs = performance.now() + grant.limits.wall_ms;
  // Strings, schema, configuration, grant and paths are captured before the first
  // asynchronous readiness wait; caller mutations cannot change this operation.
  const extractor = mode === "recover" ? undefined : dependencies.createExtractor?.(config) ??
    createSemanticProviderHttpExtractor(config, FROZEN_ANSWER_KIND);
  const lease = acquireExtractionCacheWriteLease(grant.execution_root);
  try {
    assertFrozenAnswerScope(grant, lease);
    const root = lease.stableRootPath, ledger = openFrozenAnswerLedger(root, grant, lines);
    const byKey = new Map(lines.map(line => [line.key, line]));
    const context: ProviderRequestPhysicalContext = { cacheRoot: root, model: grant.model, requestProfile: grant.request_profile,
      attemptLineageDigest: grant.lineage, maxOutputTokens: grant.limits.max_output_tokens, maximumAttemptsPerKey: 1, ledger,
      assertReservation: raw => assertAnswerRaw(raw, grant, byKey.get(raw.cache_key)!, ledger.snapshot()),
      interpretDecoded: (line, decoded) => interpretFrozenAnswer(byKey.get(line.key)!, decoded),
      publishArtifact: published => publishFrozenAnswer(root, grant, published) };
    let failure: string | null = null;
    try {
      for (const line of lines) {
        if (mode === "recover") { replayExistingProviderRequestRaws(context, line); continue; }
        const snapshot = ledger.snapshot();
        // Unknown usage or an unresolved older attempt closes further dispatch;
        // recovery remains explicit and never sends an unattempted request.
        if (snapshot.telemetry.usageUnknownAttempts > 0 || snapshot.unresolvedAttempts.length > 0) break;
        const result = await executeProviderRequestLine({ ...context, config, extractor: extractor!, writeLease: lease,
          suppliedExtractor: dependencies.createExtractor !== undefined, phaseDeadlineMs,
          ...(abortSignal === undefined ? {} : { abortSignal }), assertScope: () => {
            readFrozenAnswerGrant(pin);
            assertFrozenAnswerScope(grant, lease);
            const binding = bindSemanticProviderRequest(config, line, FROZEN_ANSWER_KIND);
            if (binding.requestDigest !== line.requestDigest || canonicalJson(binding.transportProvenance) !== canonicalJson(line.transportProvenance)) {
              throw new AlayaError("CONFLICT", "answer request changed before dispatch");
            }
          } }, line);
        if (!result.admitted) break;
      }
    } catch (cause) { failure = cause instanceof Error ? cause.message : String(cause); }
    const snapshot = ledger.snapshot();
    return { study_id: grant.study_id, mode, failure, attempts_this_invocation: snapshot.attempts - initial.attempts,
      ledger: snapshot, rows: lines.map(line => ({ task: line.task, key: line.key, ...readFrozenAnswerResult(root, grant, line), ledger: undefined })),
      cost: { reported_input_tokens: snapshot.telemetry.inputTokens, reported_output_tokens: snapshot.telemetry.outputTokens,
        unknown_usage_attempts: snapshot.telemetry.usageUnknownAttempts, reserved_upper_usd: grant.limits.spend_ceiling_usd,
        invoice_usd: null } };
  } finally { lease.release(); }
}
