import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nativeChatQuoteBasis } from "../../runs/extraction/authority/native-chat-quote.js";
import { readCurrentExtractionAuthorityRevision } from "../../runs/extraction/authority/inspection.js";
import { writeExtractionAuthorityReceiptArtifactExclusive } from "../../runs/extraction/authority/receipt/artifact-io.js";
import { canonicalExtractionTargetRoot, initializeExtractionTargetRoot } from "../../runs/extraction/authority/target-root-binding.js";
import { openExtractionAttemptLedger } from "../../runs/extraction/authority/attempt-ledger.js";
import { STEP_OPENAPI_QUOTE_BASIS } from "../../runs/extraction/authority/step-quote.js";
import {
  TEXT_MCP_PROVIDER_SESSION_CONTRACT, TEXT_MCP_PROVIDER_SESSION_ROOT_MARKER, type TextMcpProviderSessionGrant
} from "../../runs/recall-measurement/text-mcp-consumer/session-authority.js";
import type { SemanticChainConfig } from "../../runs/recall-measurement/contract.js";

export const hashBytes = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export function sessionProviderConfig() {
  return {
    model: STEP_OPENAPI_QUOTE_BASIS.selected_model,
    providerUrl: STEP_OPENAPI_QUOTE_BASIS.selected_provider_url,
    requestProfile: "step-3.5-2603-low-json-schema-v1" as const,
    apiKey: null
  };
}

/** Test-only external issuer. Production session entry cannot call this. */
export function issueTextMcpProviderSession(input: Readonly<{
  home: string;
  config: SemanticChainConfig;
  query: { query_key: string; original_query: string };
  hostIssuedInitialRecall?: boolean;
  maxModelTurns?: number;
  maxToolCalls?: number;
  wallMs?: number;
  spendCeilingUsd?: number;
  closedSessions?: readonly string[];
  closedKeys?: readonly string[];
  prompt?: Pick<TextMcpProviderSessionGrant, "caller_capability_profile" | "question_date" | "recall_dispatch_defaults">;
  limits?: TextMcpProviderSessionGrant["limits"];
}>) {
  mkdirSync(input.home, { recursive: true });
  const executionRoot = canonicalExtractionTargetRoot(join(input.home, "ledger"));
  const rootBinding = initializeExtractionTargetRoot({
    cacheRoot: executionRoot, marker: TEXT_MCP_PROVIDER_SESSION_ROOT_MARKER, purpose: "authored session issuer"
  });
  const selected = sessionProviderConfig();
  const lineage = hashBytes(input.home);
  const maxModelTurns = input.limits?.max_model_turns ?? input.maxModelTurns ?? 2;
  openExtractionAttemptLedger({
    cacheRoot: executionRoot, lineageDigest: lineage,
    cacheIdentity: { model: selected.model, requestProfile: selected.requestProfile },
    startingMissing: maxModelTurns, maximumAttempts: maxModelTurns, successfulShardCeiling: maxModelTurns,
    maximumAttemptsPerKey: 1
  });
  const quote = nativeChatQuoteBasis(selected.requestProfile, selected.model, selected.providerUrl);
  const grant = {
    contract: TEXT_MCP_PROVIDER_SESSION_CONTRACT,
    issuer: "authored-fixture-not-real-issuance",
    session_id: input.home,
    implementation_revision: readCurrentExtractionAuthorityRevision(),
    execution_root: executionRoot,
    root_binding: rootBinding,
    lineage,
    model: selected.model,
    provider_url: selected.providerUrl,
    request_profile: selected.requestProfile,
    decoding: { temperature: "provider-default", seed: "provider-default" },
    query: { query_key: input.query.query_key, original_query: input.query.original_query },
    snapshot_sha256: input.config.snapshot_sha256,
    host_issued_initial_recall: input.hostIssuedInitialRecall ?? false,
    ...input.prompt,
    limits: input.limits ?? {
      max_output_tokens: 128,
      maximum_input_tokens_per_attempt: 2_000_000,
      maximum_attempts: maxModelTurns,
      maximum_attempts_per_key: 1,
      concurrency: 1,
      wall_ms: input.wallMs ?? 60_000,
      spend_ceiling_usd: input.spendCeilingUsd ?? 1,
      max_model_turns: maxModelTurns,
      max_tool_calls: input.maxToolCalls ?? 4,
      max_input_bytes: 1_500_000,
      max_output_bytes: 64_000
    },
    price: {
      input_usd_per_million: quote.input_usd_equivalent_per_million,
      output_usd_per_million: quote.output_usd_equivalent_per_million,
      quote_basis: quote
    },
    history: {
      scope: "external-reviewed-known-closures-not-universal",
      evidence: [],
      closed_sessions: [...(input.closedSessions ?? [])],
      closed_keys: [...(input.closedKeys ?? [])]
    }
  };
  const path = join(input.home, "external-session.json");
  writeExtractionAuthorityReceiptArtifactExclusive(path, grant, lineage);
  return {
    grant, selected, pin: { path, sha256: hashBytes(readFileSync(path)) },
    consumerRoot: join(input.home, "mcp-out")
  };
}
