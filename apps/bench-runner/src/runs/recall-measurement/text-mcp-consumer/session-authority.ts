import { z } from "zod";
import { isAbsolute } from "node:path";
import { AlayaError, canonicalJson, isChatSemanticRequestProfile } from "@do-soul/alaya-protocol";
import { readCurrentExtractionAuthorityRevision } from "../../extraction/authority/inspection.js";
import { readBoundedStableRegularFile } from "../../extraction/cache-audit/bounded-artifact-reader.js";
import { assertExtractionTargetRootBinding, canonicalExtractionTargetRoot,
  ExtractionTargetRootBindingSchema } from "../../extraction/authority/target-root-binding.js";
import { inspectExtractionAttemptLedger, listExtractionAttemptLedgerRecords } from "../../extraction/authority/attempt-ledger.js";
import { NativeChatQuoteBasisSchema, assertNativeChatQuoteBasis, assertNativeChatQuoteRates } from "../../extraction/authority/native-chat-quote.js";
import { estimatedSemanticProviderUpperUsd } from "../../provider-request/request-binding.js";
import { isExtractionRequestProfile } from "../../extraction/request-profile.js";
import type { ExtractionCacheWriteLease } from "../../extraction/fill/manifest/fill-root-guard.js";
import {
  TextMcpCallerCapabilityProfileSchema, TextMcpCeilingsSchema, TextMcpConsumerQuerySchema,
  TextMcpRecallDispatchDefaultsSchema
} from "./contract.js";

export const TEXT_MCP_PROVIDER_SESSION_CONTRACT = "text-mcp-provider-session-v1" as const;
export const TEXT_MCP_PROVIDER_BOUND_KIND = "provider_bound" as const;
export const TEXT_MCP_PROVIDER_SESSION_ROOT_MARKER = Object.freeze({
  filename: ".text-mcp-provider-session-root.json", kind: "text-mcp-provider-session-root.v1"
});

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const FilePin = z.object({ path: z.string().min(1), sha256: Digest }).strict();
export type TextMcpProviderSessionPin = z.infer<typeof FilePin>;

const SessionQuery = TextMcpConsumerQuerySchema.pick({ query_key: true, original_query: true });
const Limits = TextMcpCeilingsSchema.extend({
  max_output_tokens: z.number().int().positive(),
  maximum_input_tokens_per_attempt: z.number().int().positive(),
  maximum_attempts: z.number().int().positive().max(16),
  maximum_attempts_per_key: z.literal(1),
  concurrency: z.literal(1),
  spend_ceiling_usd: z.number().finite().nonnegative()
}).strict();

const Grant = z.object({
  contract: z.literal(TEXT_MCP_PROVIDER_SESSION_CONTRACT),
  issuer: z.string().min(1),
  session_id: z.string().min(1),
  implementation_revision: z.string().min(1),
  execution_root: z.string().min(1),
  root_binding: ExtractionTargetRootBindingSchema,
  lineage: Digest,
  model: z.string().min(1),
  provider_url: z.string().url(),
  request_profile: z.string().min(1),
  decoding: z.object({ temperature: z.literal("provider-default"), seed: z.literal("provider-default") }).strict(),
  query: SessionQuery,
  snapshot_sha256: Digest,
  host_issued_initial_recall: z.boolean(),
  caller_capability_profile: TextMcpCallerCapabilityProfileSchema.optional(),
  question_date: z.string().min(1).optional(),
  recall_dispatch_defaults: TextMcpRecallDispatchDefaultsSchema.optional(),
  limits: Limits,
  price: z.object({
    input_usd_per_million: z.number().finite().nonnegative(),
    output_usd_per_million: z.number().finite().nonnegative(),
    quote_basis: NativeChatQuoteBasisSchema
  }).strict(),
  history: z.object({
    scope: z.literal("external-reviewed-known-closures-not-universal"),
    evidence: z.array(FilePin),
    closed_sessions: z.array(z.string().min(1)),
    closed_keys: z.array(Digest)
  }).strict()
}).strict();
export type TextMcpProviderSessionGrant = z.infer<typeof Grant>;

/** Host-supplied pin. This consumer has no issuance, renewal, or root initialization API. */
export function readTextMcpProviderSessionGrant(pin: TextMcpProviderSessionPin): TextMcpProviderSessionGrant {
  const selected = FilePin.parse(pin);
  const file = readBoundedStableRegularFile({ path: selected.path, maxBytes: 16 * 1024 * 1024, label: "external provider session" });
  check(file.identity.sha256 === selected.sha256, "external session pin mismatch");
  const grant = Grant.parse(JSON.parse(file.bytes.toString("utf8")));
  check(grant.implementation_revision === readCurrentExtractionAuthorityRevision(), "session grant executable revision drift");
  check(isChatSemanticRequestProfile(grant.request_profile), "session grant requires a native chat profile");
  check(canonicalExtractionTargetRoot(grant.execution_root) === grant.execution_root, "session grant root must be canonical");
  check(isAbsolute(grant.execution_root) && grant.history.evidence.every(item => isAbsolute(item.path)),
    "external session execution/history paths must be absolute");
  assertNativeChatQuoteBasis(grant.request_profile, grant.model, grant.provider_url, grant.price.quote_basis);
  assertNativeChatQuoteRates(grant.request_profile, grant.price.input_usd_per_million, grant.price.output_usd_per_million,
    grant.price.quote_basis);
  check(estimatedSemanticProviderUpperUsd(grant.limits, grant.price.input_usd_per_million,
    grant.price.output_usd_per_million) <= grant.limits.spend_ceiling_usd, "session grant exceeds finite spend ceiling");
  check(grant.limits.max_model_turns === grant.limits.maximum_attempts, "session grant must bind one attempt per model turn");
  check(!grant.history.closed_sessions.includes(grant.session_id), "known closed provider session");
  return grant;
}

export function assertTextMcpProviderSessionScope(grant: TextMcpProviderSessionGrant, admittedKeys: readonly string[],
  lease?: ExtractionCacheWriteLease) {
  assertExtractionTargetRootBinding({ cacheRoot: grant.execution_root, marker: TEXT_MCP_PROVIDER_SESSION_ROOT_MARKER,
    binding: grant.root_binding, purpose: "externally issued provider session", ...(lease ? { writeLease: lease } : {}) });
  for (const evidence of grant.history.evidence) {
    const file = readBoundedStableRegularFile({ path: evidence.path, maxBytes: 16 * 1024 * 1024, label: "known session history" });
    check(file.identity.sha256 === evidence.sha256, "known session history changed");
  }
  const records = listExtractionAttemptLedgerRecords(grant.execution_root);
  check(records.length === 1 && records[0]!.lineage_digest === grant.lineage, "external session ledger missing or replaced");
  const ledger = inspectExtractionAttemptLedger({ cacheRoot: grant.execution_root, lineageDigest: grant.lineage,
    cacheIdentity: textMcpProviderSessionCacheIdentity(grant) });
  check(ledger !== undefined && ledger.historyComplete && ledger.maximumAttempts === grant.limits.maximum_attempts &&
    ledger.startingMissing === grant.limits.max_model_turns && ledger.successfulShardCeiling === grant.limits.max_model_turns,
  "external session ledger limits/history drift");
  const allowed = new Set(admittedKeys);
  check([...ledger.unresolvedAttempts, ...ledger.settledAttempts, ...ledger.transportFailures].every(item => allowed.has(item.cacheKey)),
    "external session ledger contains an ungranted request");
  check(admittedKeys.every(key => !grant.history.closed_keys.includes(key)), "known closed session request");
  return ledger;
}

export function assertTextMcpProviderSessionConsumer(grant: TextMcpProviderSessionGrant, consumer: Readonly<{
  snapshot_sha256: string;
  query: { query_key: string; original_query: string };
  host_issued_initial_recall: boolean;
  ceilings: { max_model_turns: number; max_tool_calls: number; max_input_bytes: number; max_output_bytes: number; wall_ms: number };
  caller_capability_profile?: z.infer<typeof TextMcpCallerCapabilityProfileSchema>;
  question_date?: string;
  recall_dispatch_defaults?: z.infer<typeof TextMcpRecallDispatchDefaultsSchema>;
}>) {
  check(consumer.snapshot_sha256 === grant.snapshot_sha256, "session snapshot identity mismatch");
  check(canonicalJson(consumer.query) === canonicalJson(grant.query), "session query identity mismatch");
  check(consumer.host_issued_initial_recall === grant.host_issued_initial_recall, "session host-setup binding mismatch");
  check(consumer.ceilings.max_model_turns === grant.limits.max_model_turns &&
    consumer.ceilings.max_tool_calls === grant.limits.max_tool_calls &&
    consumer.ceilings.max_input_bytes === grant.limits.max_input_bytes &&
    consumer.ceilings.max_output_bytes === grant.limits.max_output_bytes &&
    consumer.ceilings.wall_ms === grant.limits.wall_ms, "session consumer ceilings differ from grant");
  if (grant.caller_capability_profile !== undefined) {
    check(consumer.caller_capability_profile === grant.caller_capability_profile,
      "session caller capability profile mismatch");
  }
  if (grant.question_date !== undefined) {
    check(consumer.question_date === grant.question_date, "session question date mismatch");
  }
  if (grant.recall_dispatch_defaults !== undefined) {
    check(canonicalJson(consumer.recall_dispatch_defaults ?? null) ===
      canonicalJson(grant.recall_dispatch_defaults), "session recall dispatch defaults mismatch");
  }
}

export function textMcpProviderSessionCacheIdentity(grant: TextMcpProviderSessionGrant) {
  if (!isExtractionRequestProfile(grant.request_profile)) throw new AlayaError("VALIDATION", "unsupported session profile");
  return { model: grant.model, requestProfile: grant.request_profile };
}

export function check(value: boolean, message: string): asserts value {
  if (!value) throw new AlayaError("CONFLICT", message);
}
