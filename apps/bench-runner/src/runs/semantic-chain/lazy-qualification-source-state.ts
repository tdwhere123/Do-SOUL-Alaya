import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { censusCompleteSourceRecords } from "../snapshot/source-records/census.js";
import { readRetainedSourcePublicationOwners } from "../snapshot/source-records/prepare-associations.js";
import { inspectCachedSourceSemantic } from "../extraction/cache/source-semantic-artifact.js";
import { listProviderRawAttempts } from "../extraction/fill/provider-raw-attempt.js";
import { listExtractionAttemptLedgerRecords } from "../extraction/authority/attempt-ledger.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, parseExtractionOpenSemanticsGeneration,
  prepareSourceSemanticRequestLine, sourceSemanticArtifactPreparations } from "../extraction/request-artifact.js";
import { chainIdentity } from "./contract.js";
import type { LazyQualificationConfig, LazyQualificationWindow } from "./lazy-qualification.js";

function sourceAttemptHistory(cacheRoot: string, key: string, config: LazyQualificationConfig) {
  const raw = listProviderRawAttempts(cacheRoot, key);
  const ledgers = listExtractionAttemptLedgerRecords(cacheRoot).filter(record =>
    record.cache_identity.model === config.source_population.model &&
    record.cache_identity.requestProfile === config.source_population.requestProfile);
  const attempts = new Set<string>();
  let complete = true;
  for (const record of ledgers) {
    const all = new Map<number, string>();
    for (const entry of [...record.unresolved_attempts, ...(record.settled_attempts ?? []), ...record.transport_failures]) {
      const prior = all.get(entry.attempt_ordinal);
      if (prior !== undefined && prior !== entry.cache_key) throw new AlayaError("CONFLICT", "source attempt ordinal changed cache owner");
      all.set(entry.attempt_ordinal, entry.cache_key);
    }
    if (all.size !== record.attempts) complete = false;
    for (const [ordinal, cacheKey] of all) if (cacheKey === key) attempts.add(`${record.lineage_digest}:${ordinal}`);
  }
  if (raw.some(row => ![...attempts].some(ref => ref.endsWith(`:${row.attempt_ordinal}`)))) complete = false;
  return { raw, ledgers: ledgers.filter(record => record.pending_keys.includes(key) ||
    record.unresolved_attempts.some(row => row.cache_key === key) ||
    record.settled_attempts?.some(row => row.cache_key === key) ||
    record.transport_failures.some(row => row.cache_key === key)),
  attemptRefs: [...attempts].sort(), rawRefs: raw.map(row => chainIdentity({
    ordinal: row.attempt_ordinal, request: row.request_digest,
    digest: row.decoded_text_digest, extracted_at: row.extracted_at })), complete };
}

export function selectedSourceState(source: Awaited<ReturnType<typeof censusCompleteSourceRecords>>["records"][number],
  config: LazyQualificationConfig, planned: ReturnType<typeof readRetainedSourcePublicationOwners>["planned"],
  artifacts: readonly { key: string; cache_root: string; status: string; reason?: string }[]) {
  const generation = parseExtractionOpenSemanticsGeneration(config.source_population.openSemantics ?? EXTRACTION_OPEN_SEMANTICS_GENERATION);
  const preparations = sourceSemanticArtifactPreparations(source.content_bytes, "complete-source", generation);
  if (preparations.length !== 1) throw new AlayaError("CONFLICT", "selected source has no single host preparation");
  const prepared = preparations[0]!;
  if (prepared.status === "unsupported_source") return { key: null, cache_root: null,
    state: "unsupported_source" as const, cache_identity: null, attempt_identity: null,
    starting_attempt_refs: [], starting_raw_refs: [], attempt_history_complete: true };
  const line = prepareSourceSemanticRequestLine(prepared.semantic, [], config.source_population);
  const owner = planned.get(line.key);
  const artifact = artifacts.find(row => row.key === line.key);
  if (owner === undefined) return { key: line.key, cache_root: null,
    state: "unowned" as const, cache_identity: null, attempt_identity: null,
    starting_attempt_refs: [], starting_raw_refs: [], attempt_history_complete: true };
  const cacheRoot = owner.cacheRoot;
  const cache = inspectCachedSourceSemantic(cacheRoot, line.key,
    config.source_population.model, config.source_population.requestProfile);
  const history = sourceAttemptHistory(cacheRoot, line.key, config);
  const { raw, ledgers } = history;
  const cacheIdentity = cache.status === "hit" ? chainIdentity(cache.admitted) : cache.status === "invalid"
    ? chainIdentity({ invalid: cache.reason }) : null;
  const attemptIdentity = raw.length + ledgers.length === 0 ? null : chainIdentity({
    raw: raw.map(row => ({ ordinal: row.attempt_ordinal, digest: row.decoded_text_digest,
      failure: row.failure_classification ?? null, finish: row.finish_reason, complete: row.full_replay_possible })),
    ledgers: ledgers.map(row => ({ lineage: row.lineage_digest, pending: row.pending_keys,
      unresolved: row.unresolved_attempts, settled: row.settled_attempts ?? [], failures: row.transport_failures }))
  });
  const state = artifact?.reason === "foreign_root" || artifact?.cache_root !== undefined && artifact.cache_root !== cacheRoot
    ? "foreign_cache"
    : artifact?.status === "invalid" || artifact?.status === "unbound" ? "cache_invalid"
    : cache.status === "hit" ? cache.admitted.outcome.status === "interpreted" ? "cache_hit_interpreted"
    : cache.admitted.outcome.status === "abstained" ? "cache_hit_abstained" : "cache_hit_empty"
    : cache.status === "invalid" ? "cache_invalid"
    : ledgers.some(row => row.pending_keys.includes(line.key) || row.unresolved_attempts.some(attempt => attempt.cache_key === line.key))
      ? "attempt_pending"
    : raw.some(row => row.transport_failure !== undefined) || ledgers.some(row => row.transport_failures.some(attempt => attempt.cache_key === line.key))
      ? "attempt_failed" : attemptIdentity !== null ? "attempt_unknown" : "cache_miss";
  return { key: line.key, cache_root: cacheRoot, state, cache_identity: cacheIdentity,
    attempt_identity: attemptIdentity, starting_attempt_refs: history.attemptRefs,
    starting_raw_refs: history.rawRefs, attempt_history_complete: history.complete };
}

export function selectedProducerAttempts(window: LazyQualificationWindow) {
  const selected = new Map<string, typeof window.window[number]>();
  for (const row of window.window) {
    if (row.key === null || row.cache_root === null) continue;
    const existing = selected.get(row.key);
    if (existing !== undefined && (existing.cache_root !== row.cache_root ||
        canonicalJson(existing.starting_attempt_refs) !== canonicalJson(row.starting_attempt_refs) ||
        canonicalJson(existing.starting_raw_refs) !== canonicalJson(row.starting_raw_refs))) {
      throw new AlayaError("CONFLICT", "duplicate selected source request has conflicting cache ownership");
    }
    selected.set(row.key, row);
  }
  let newAttempts = 0, newRaw = 0, oldAttemptRaw = 0, inputTokens = 0, outputTokens = 0,
    unknownUsage = 0, unresolved = 0, complete = true;
  for (const [key, row] of selected) {
    const history = sourceAttemptHistory(row.cache_root!, key, window.config);
    const priorAttempts = new Set(row.starting_attempt_refs), priorRaw = new Set(row.starting_raw_refs);
    if (row.starting_attempt_refs.some(ref => !history.attemptRefs.includes(ref)) ||
        row.starting_raw_refs.some(ref => !history.rawRefs.includes(ref))) {
      throw new AlayaError("CONFLICT", "selected source attempt history changed after window freeze");
    }
    complete &&= row.attempt_history_complete && history.complete;
    const added = history.attemptRefs.filter(ref => !priorAttempts.has(ref));
    const priorOrdinals = new Set(row.starting_attempt_refs.map(ref => ref.slice(ref.lastIndexOf(":") + 1)));
    const copiedOrdinal = added.some(ref => priorOrdinals.has(ref.slice(ref.lastIndexOf(":") + 1)));
    if (copiedOrdinal) complete = false;
    if (added.some(ref => !priorOrdinals.has(ref.slice(ref.lastIndexOf(":") + 1))) &&
        !window.selected_missing_keys.includes(key)) {
      throw new AlayaError("CONFLICT", "new source attempt was not a frozen selected cache miss");
    }
    const addedOrdinals = new Map<number, number>();
    for (const ref of added) {
      const ordinal = Number(ref.slice(ref.lastIndexOf(":") + 1));
      addedOrdinals.set(ordinal, (addedOrdinals.get(ordinal) ?? 0) + 1);
    }
    newAttempts += added.length;
    history.raw.forEach((raw, index) => {
      if (priorRaw.has(history.rawRefs[index]!)) return;
      newRaw++;
      if (!addedOrdinals.has(raw.attempt_ordinal)) { oldAttemptRaw++; return; }
      if (addedOrdinals.get(raw.attempt_ordinal) !== 1) { complete = false; return; }
      if (raw.usage_known && raw.usage !== null) {
        inputTokens += raw.usage.inputTokens; outputTokens += raw.usage.outputTokens;
      } else unknownUsage++;
    });
    for (const [ordinal, count] of addedOrdinals) {
      if (count !== 1) { complete = false; continue; }
      if (!history.raw.some(raw => raw.attempt_ordinal === ordinal)) { unknownUsage++; unresolved++; }
    }
  }
  return { new_authorized_attempts: complete ? newAttempts : null, new_raw_receipts: newRaw,
    preexisting_attempt_raw_receipts: oldAttemptRaw, reported_input_tokens: complete ? inputTokens : null,
    reported_output_tokens: complete ? outputTokens : null,
    unknown_usage_attempts: complete ? unknownUsage : null,
    unresolved_new_attempts: complete ? unresolved : null, attempt_history_complete: complete };
}
