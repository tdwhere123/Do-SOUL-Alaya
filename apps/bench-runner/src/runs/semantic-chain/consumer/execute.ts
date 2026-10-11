import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { refuseRecallCampaignLiveExtraction } from "@do-soul/alaya-core";
import { verifyConsumerAuthority, assertConsumerExecutionScope } from "./authority.js";
import { TASK_CONSUMER_SCHEMA_NAME, type ConsumerLine } from "./input.js";
import { assertConsumerRaw, inspectConsumerResult, interpretConsumerResponse, openConsumerAttemptLedger,
  publishConsumerResult } from "./persist.js";
import { createSemanticProviderHttpExtractor } from "../../compile-seed/http/semantic-provider-http.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import { acquireExtractionCacheWriteLease, withExtractionCacheWriteLease } from "../../extraction/fill/manifest/fill-root-guard.js";
import { bindSemanticProviderRequest } from "../../provider-request/request-binding.js";
import { executeProviderRequestLine, replayExistingProviderRequestRaws,
  type ProviderRequestPhysicalContext } from "../../provider-request/execution.js";

/** Recovery only settles retained evidence; it never acquires a provider transport. */
export async function executeSemanticChainConsumer(input: Readonly<{
  authority: unknown; config?: CompileSeedExtractionConfig; mode: "execute" | "recover";
}>) {
  refuseRecallCampaignLiveExtraction("extraction_write");
  const initial = verifyConsumerAuthority(input.authority);
  const lease = acquireExtractionCacheWriteLease(initial.authority.execution_scope.execution_root_path);
  return withExtractionCacheWriteLease(lease, async () => {
    const current = verifyConsumerAuthority(initial.authority, lease), { authority, lines } = current;
    const root = lease.stableRootPath;
    const ledger = openConsumerAttemptLedger(root, authority, lines, lease);
    const context = physicalContext(root, authority, lines, ledger);
    const before = ledger.snapshot().attempts;
    const rows = [];
    for (const line of lines) {
      assertConsumerExecutionScope(authority, lease);
      const existing = replayExistingProviderRequestRaws(context, line);
      let state = existing.done ? existing : { classified: "unattempted", admitted: false, attempts: existing.attempts };
      if (!existing.done && input.mode === "execute") {
        const config = assertDispatchConfig(input.config, line, authority.limits.max_output_tokens);
        state = await executeProviderRequestLine({ ...context, config, suppliedExtractor: false, writeLease: lease,
          extractor: createSemanticProviderHttpExtractor(config, TASK_CONSUMER_SCHEMA_NAME),
          assertScope: () => { verifyConsumerAuthority(authority, lease); assertDispatchConfig(input.config, line, authority.limits.max_output_tokens); }
        }, line);
      }
      const retained = inspectConsumerResult(root, authority, line);
      rows.push({ arm: line.arm, key: line.key, status: retained?.result.outcome.status ?? state.classified,
        result: retained?.result ?? null });
    }
    assertConsumerExecutionScope(authority, lease);
    return { contract: "semantic-chain-consumer-run-v1" as const, authority_identity: authority.identity_digest,
      new_attempts: ledger.snapshot().attempts - before, rows, ledger: ledger.snapshot(), fidelity: "unassessed" as const };
  });
}

function assertDispatchConfig(config: CompileSeedExtractionConfig | undefined, line: ConsumerLine, maxOutputTokens: number) {
  if (config === undefined) throw new AlayaError("VALIDATION", "consumer execution requires provider configuration");
  const bound = bindSemanticProviderRequest(config, { systemPrompt: line.systemPrompt, userPrompt: line.userPrompt,
    responseJsonSchema: line.responseJsonSchema, maxOutputTokens }, TASK_CONSUMER_SCHEMA_NAME);
  if (bound.requestDigest !== line.requestDigest || canonicalJson(bound.transportProvenance) !== canonicalJson(line.transportProvenance)) {
    throw new AlayaError("CONFLICT", "consumer dispatch differs from its frozen wire request");
  }
  return config;
}

function physicalContext(root: string, authority: ReturnType<typeof verifyConsumerAuthority>["authority"],
  lines: readonly ConsumerLine[], ledger: ReturnType<typeof openConsumerAttemptLedger>): ProviderRequestPhysicalContext {
  const byKey = new Map(lines.map(line => [line.key, line]));
  const find = (key: string) => {
    const line = byKey.get(key);
    if (line === undefined) throw new AlayaError("CONFLICT", "consumer request key is outside authority");
    return line;
  };
  return { cacheRoot: root, model: authority.model, requestProfile: authority.request_profile,
    attemptLineageDigest: authority.attempt_lineage_digest, maxOutputTokens: authority.limits.max_output_tokens,
    maximumAttemptsPerKey: 1, ledger,
    assertReservation: raw => assertConsumerRaw(raw, authority, find(raw.cache_key), ledger.snapshot()),
    interpretDecoded: (_line, decoded) => interpretConsumerResponse(decoded),
    publishArtifact: published => publishConsumerResult(root, authority, find(published.line.key), published)
  };
}
