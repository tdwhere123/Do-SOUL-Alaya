import { z } from "zod";
import { isAbsolute } from "node:path";
import { AlayaError, canonicalJson, isChatSemanticRequestProfile } from "@do-soul/alaya-protocol";
import { readCurrentExtractionAuthorityRevision } from "../extraction/authority/inspection.js";
import { readBoundedStableRegularFile } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { assertExtractionTargetRootBinding, canonicalExtractionTargetRoot,
  ExtractionTargetRootBindingSchema } from "../extraction/authority/target-root-binding.js";
import { inspectExtractionAttemptLedger, listExtractionAttemptLedgerRecords } from "../extraction/authority/attempt-ledger.js";
import { NativeChatQuoteBasisSchema, assertNativeChatQuoteBasis, assertNativeChatQuoteRates } from "../extraction/authority/native-chat-quote.js";
import { estimatedSemanticProviderUpperUsd } from "../provider-request/request-binding.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import type { ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import { FROZEN_ANSWER_CONTRACT, type FrozenAnswerLine } from "./input.js";

export const FROZEN_ANSWER_ROOT_MARKER = Object.freeze({ filename: ".frozen-answer-root.json", kind: "frozen-answer-root.v1" });
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Task = z.object({ ordinal: z.number().int().positive(), question_id: z.string().min(1), arm: z.string().min(1) }).strict();
const FilePin = z.object({ path: z.string().min(1), sha256: Digest }).strict();
export type FrozenAnswerGrantPin = z.infer<typeof FilePin>;
const Grant = z.object({ contract: z.literal(FROZEN_ANSWER_CONTRACT), issuer: z.string().min(1), study_id: z.string().min(1),
  implementation_revision: z.string().min(1), capture_root: z.string().min(1),
  execution_root: z.string().min(1), root_binding: ExtractionTargetRootBindingSchema, lineage: Digest,
  model: z.string().min(1), provider_url: z.string().url(), request_profile: z.string().min(1),
  decoding: z.object({ temperature: z.literal("provider-default"), seed: z.literal("provider-default") }).strict(),
  limits: z.object({ max_output_tokens: z.number().int().positive(), maximum_input_tokens_per_attempt: z.number().int().positive(),
    maximum_windows: z.number().int().positive().max(10), maximum_attempts: z.number().int().positive().max(16),
    maximum_attempts_per_key: z.literal(1), concurrency: z.literal(1), wall_ms: z.number().int().positive(),
    spend_ceiling_usd: z.number().finite().nonnegative() }).strict(),
  price: z.object({ input_usd_per_million: z.number().finite().nonnegative(), output_usd_per_million: z.number().finite().nonnegative(),
    quote_basis: NativeChatQuoteBasisSchema }).strict(),
  tasks: z.array(z.object({ task: Task, key: Digest, request_digest: Digest }).strict()).min(1).max(16),
  history: z.object({ scope: z.literal("external-reviewed-known-closures-not-universal"),
    evidence: z.array(FilePin), closed_tasks: z.array(Task), closed_keys: z.array(Digest) }).strict()
}).strict();
export type FrozenAnswerGrant = z.infer<typeof Grant>;

/** The host supplies this pin through its trusted issuance channel, never a capture
 * or workset field. This consumer has no issuance, renewal or root initialization API.
 * Hashes prove selected bytes only; the external issuer owns the scope/closure review. */
export function readFrozenAnswerGrant(pin: FrozenAnswerGrantPin): FrozenAnswerGrant {
  const selected = FilePin.parse(pin);
  const file = readBoundedStableRegularFile({ path: selected.path, maxBytes: 16 * 1024 * 1024, label: "external answer grant" });
  check(file.identity.sha256 === selected.sha256, "external grant pin mismatch");
  const grant = Grant.parse(JSON.parse(file.bytes.toString("utf8")));
  check(grant.implementation_revision === readCurrentExtractionAuthorityRevision(), "answer grant executable revision drift");
  check(isChatSemanticRequestProfile(grant.request_profile), "answer grant requires a native chat profile");
  check(canonicalExtractionTargetRoot(grant.execution_root) === grant.execution_root, "answer grant root must be canonical");
  check(isAbsolute(grant.capture_root) && grant.history.evidence.every(file => isAbsolute(file.path)),
    "external grant capture/history paths must be absolute");
  assertNativeChatQuoteBasis(grant.request_profile, grant.model, grant.provider_url, grant.price.quote_basis);
  assertNativeChatQuoteRates(grant.request_profile, grant.price.input_usd_per_million, grant.price.output_usd_per_million, grant.price.quote_basis);
  check(estimatedSemanticProviderUpperUsd(grant.limits, grant.price.input_usd_per_million,
    grant.price.output_usd_per_million) <= grant.limits.spend_ceiling_usd, "answer grant exceeds finite spend ceiling");
  check(grant.tasks.length === grant.limits.maximum_attempts && new Set(grant.tasks.map(task => task.key)).size === grant.tasks.length,
    "answer grant must bind one attempt per distinct request");
  for (const task of grant.tasks) check(!grant.history.closed_keys.includes(task.key) &&
    !grant.history.closed_tasks.some(closed => canonicalJson(closed) === canonicalJson(task.task)), "known closed answer task");
  return grant;
}

export function assertFrozenAnswerScope(grant: FrozenAnswerGrant, lease?: ExtractionCacheWriteLease) {
  assertExtractionTargetRootBinding({ cacheRoot: grant.execution_root, marker: FROZEN_ANSWER_ROOT_MARKER,
    binding: grant.root_binding, purpose: "externally issued answer study", ...(lease ? { writeLease: lease } : {}) });
  for (const evidence of grant.history.evidence) {
    const file = readBoundedStableRegularFile({ path: evidence.path, maxBytes: 16 * 1024 * 1024, label: "known answer history" });
    check(file.identity.sha256 === evidence.sha256, "known answer history changed");
  }
  const records = listExtractionAttemptLedgerRecords(grant.execution_root);
  check(records.length === 1 && records[0]!.lineage_digest === grant.lineage, "external study ledger missing or replaced");
  const ledger = inspectExtractionAttemptLedger({ cacheRoot: grant.execution_root, lineageDigest: grant.lineage,
    cacheIdentity: frozenAnswerCacheIdentity(grant) });
  check(ledger !== undefined && ledger.historyComplete && ledger.maximumAttempts === grant.limits.maximum_attempts &&
    ledger.startingMissing === grant.tasks.length && ledger.successfulShardCeiling === grant.tasks.length,
  "external study ledger limits/history drift");
  const allowed = new Set(grant.tasks.map(task => task.key));
  check([...ledger.unresolvedAttempts, ...ledger.settledAttempts, ...ledger.transportFailures].every(item => allowed.has(item.cacheKey)),
    "external study ledger contains an ungranted request");
  return ledger;
}

export function assertFrozenAnswerRequests(grant: FrozenAnswerGrant, lines: readonly FrozenAnswerLine[]) {
  check(canonicalJson(lines.map(line => ({ task: line.task, key: line.key, request_digest: line.requestDigest }))) ===
    canonicalJson(grant.tasks), "external grant task/request binding mismatch");
  check(lines.every(line => line.inputByteUpper <= grant.limits.maximum_input_tokens_per_attempt &&
    line.windowCount <= grant.limits.maximum_windows), "answer request exceeds granted input/window bounds");
}

export function frozenAnswerCacheIdentity(grant: FrozenAnswerGrant) {
  if (!isExtractionRequestProfile(grant.request_profile)) throw new AlayaError("VALIDATION", "unsupported answer profile");
  return { model: grant.model, requestProfile: grant.request_profile };
}
function check(value: boolean, message: string): asserts value { if (!value) throw new AlayaError("CONFLICT", message); }
