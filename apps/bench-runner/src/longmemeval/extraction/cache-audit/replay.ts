import { createHash } from "node:crypto";
import {
  PRODUCT_FORMATION_DEFAULTS,
  RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER,
  RULE_BASED_EVIDENCE_FACT_FRAME_NORMALIZER_OPERATOR_ID,
  materializeEvidenceFactFrameFormation
} from "@do-soul/alaya-core";
import type { EvidenceFactFrameFormationStatus } from "@do-soul/alaya-protocol";
import {
  auditOfficialApiSignalFormation,
  buildEvidenceInput,
  buildFactFrameFormationProposal,
  parseOfficialApiSemanticFactorGraphProjectionAudit,
  type OfficialApiSemanticFactorGraphProjectionAudit
} from "@do-soul/alaya-soul";
import {
  inspectCachedExtraction,
  type CachedExtractionInspection
} from "../../compile-seed/compile-seed-cache.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import type { ExtractionOccurrence } from "./occurrence-index.js";

export type ExtractionReplayDisposition = "admitted" | "deferred" | "rejected" | "invalid";
export const EXTRACTION_REPLAY_FORMATION_SEMANTICS_VERSION =
  "extraction-replay-fact-frame-formation-v2";
export interface ExtractionReplayFormationPolicy {
  readonly semanticsVersion: string;
  readonly fullTurnEvidence: boolean;
  readonly normalizerOperatorId: string;
}
export const EXTRACTION_REPLAY_FORMATION_POLICY: Readonly<ExtractionReplayFormationPolicy> = Object.freeze({
  semanticsVersion: EXTRACTION_REPLAY_FORMATION_SEMANTICS_VERSION,
  fullTurnEvidence: PRODUCT_FORMATION_DEFAULTS.fullTurnEvidence,
  normalizerOperatorId: RULE_BASED_EVIDENCE_FACT_FRAME_NORMALIZER_OPERATOR_ID
});

export interface ExtractionReplayFactFrameFormation {
  readonly status: EvidenceFactFrameFormationStatus;
  readonly producerOperatorId: string | null;
  readonly factKeyProjectionCount: number;
  readonly factKeyProjectionSha256: string;
}

export interface ExtractionReplayEntry {
  readonly index: number;
  readonly sourceCacheKey: string;
  readonly disposition: ExtractionReplayDisposition;
  readonly stage: string;
  readonly reason: string;
  readonly sourceAssertion?: string;
  readonly formedContentSha256?: string;
  readonly semanticFactorGraphProjection?:
    OfficialApiSemanticFactorGraphProjectionAudit;
  readonly factFrameFormation?: Readonly<ExtractionReplayFactFrameFormation>;
}

export interface ExtractionReplayOccurrence {
  readonly occurrence: ExtractionOccurrence;
  readonly rawJsonSha256s: readonly string[] | null;
  readonly entries: readonly ExtractionReplayEntry[];
}

export interface ExtractionReplayResult {
  readonly occurrences: readonly ExtractionReplayOccurrence[];
  readonly factFramePolicy: Readonly<ExtractionReplayFormationPolicy>;
  readonly closure: Readonly<{
    occurrenceCount: number;
    accountedOccurrences: number;
    elementCount: number;
    accountedElements: number;
    admitted: number;
    deferred: number;
    rejected: number;
    invalid: number;
    ledgerSha256: string;
  }>;
  readonly factFrameClosure: Readonly<{
    admittedSignalCount: number;
    accountedSignalCount: number;
    formed: number;
    ineligible: number;
    unavailable: number;
    rejected: number;
    factKeyProjectionCount: number;
  }>;
}

export type ExtractionReplayAuditor = (
  input: Parameters<typeof auditOfficialApiSignalFormation>[0]
) => Readonly<{
  entries: ReturnType<typeof auditOfficialApiSignalFormation>["entries"];
}>;

export function replayExtractionOccurrences(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly occurrences: readonly ExtractionOccurrence[];
  readonly audit?: ExtractionReplayAuditor;
  readonly requireSemanticFactorGraph?: boolean;
  /** Keys rejected by the strict first pass and reserved for provider refill. */
  readonly semanticQuarantinedCacheKeys?: ReadonlySet<string>;
  /** A refill audit may defer absent shards while still rejecting malformed ones. */
  readonly allowMissingShards?: boolean;
}): ExtractionReplayResult {
  const cached = new Map<string, CachedExtractionInspection>();
  const audit = input.audit ?? auditOfficialApiSignalFormation;
  const factFramePolicy = EXTRACTION_REPLAY_FORMATION_POLICY;
  const occurrences = input.occurrences.map((occurrence) => replayOccurrence({
    ...input, occurrence, cached, audit
  })).sort(compareReplayOccurrences);
  return Object.freeze({
    occurrences: Object.freeze(occurrences),
    factFramePolicy,
    closure: closeReplay(occurrences, factFramePolicy),
    factFrameClosure: closeFactFrameFormations(occurrences)
  });
}

export function hashExtractionReplay(result: ExtractionReplayResult): string {
  return hashReplayOccurrences(result.occurrences, result.factFramePolicy);
}

function hashReplayOccurrences(
  occurrences: readonly ExtractionReplayOccurrence[],
  factFramePolicy: ExtractionReplayResult["factFramePolicy"]
): string {
  const canonical = occurrences.map((occurrence) => ({
    occurrence_id: occurrence.occurrence.id,
    cache_keys: occurrence.occurrence.cacheKeys,
    source_observed_at: occurrence.occurrence.sourceObservedAt,
    raw_json_sha256s: occurrence.rawJsonSha256s,
    entries: occurrence.entries
  }));
  return createHash("sha256").update(JSON.stringify({
    fact_frame_policy: {
      semantics_version: factFramePolicy.semanticsVersion,
      full_turn_evidence: factFramePolicy.fullTurnEvidence,
      normalizer_operator_id: factFramePolicy.normalizerOperatorId
    },
    occurrences: canonical
  }), "utf8").digest("hex");
}

function replayOccurrence(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly occurrence: ExtractionOccurrence;
  readonly cached: Map<string, CachedExtractionInspection>;
  readonly audit: ExtractionReplayAuditor;
  readonly requireSemanticFactorGraph?: boolean;
  readonly semanticQuarantinedCacheKeys?: ReadonlySet<string>;
  readonly allowMissingShards?: boolean;
}): ExtractionReplayOccurrence {
  const shards = inspectOccurrenceShards(input);
  const unavailable = shards.find(({ inspection }) => inspection.status !== "hit");
  if (unavailable !== undefined && unavailable.inspection.status !== "hit") {
    return unavailableOccurrence(
      input.occurrence, unavailable.cacheKey, unavailable.inspection,
      input.allowMissingShards === true
    );
  }
  const hits = shards.map(({ inspection }) =>
    inspection as Extract<CachedExtractionInspection, { readonly status: "hit" }>);
  return Object.freeze({
    occurrence: input.occurrence,
    rawJsonSha256s: Object.freeze(hits.map(({ rawJsonSha256 }) => rawJsonSha256)),
    entries: auditOccurrenceShards(input, hits)
  });
}

function auditOccurrenceShards(
  input: Parameters<typeof replayOccurrence>[0],
  shards: readonly Extract<CachedExtractionInspection, { readonly status: "hit" }>[]
): readonly ExtractionReplayEntry[] {
  const entries: ExtractionReplayEntry[] = [];
  for (const [batchIndex, shard] of shards.entries()) {
    const entryOffset = entries.length;
    const result = input.audit({
      raw_json: shard.rawJson,
      turn_content: input.occurrence.turnContent,
      turn_messages: input.occurrence.turnMessages,
      workspace_id: replayScopedId("workspace", input.occurrence.id),
      run_id: replayScopedId("run", input.occurrence.id),
      surface_id: null,
      created_at: input.occurrence.sourceObservedAt,
      source_observed_at: input.occurrence.sourceObservedAt,
      require_source_observed_at: true,
      require_semantic_factor_graph: input.requireSemanticFactorGraph === true,
      signal_id_for: (index) => replayScopedId(
        "signal", `${input.occurrence.id}:${batchIndex}:${index}`
      )
    });
    entries.push(...result.entries.map((entry) => Object.freeze({
      index: entryOffset + entry.index,
      sourceCacheKey: input.occurrence.cacheKeys[batchIndex]!,
      disposition: entry.disposition,
      stage: entry.stage,
      reason: entry.reason,
      ...semanticFactorGraphProjection(entry.semantic_factor_graph_projection),
      ...formationCommitment(entry.signal)
    })));
  }
  return Object.freeze(entries);
}

function formationCommitment(
  signal: ReturnType<typeof auditOfficialApiSignalFormation>["entries"][number]["signal"]
): Pick<
  ExtractionReplayEntry,
  "sourceAssertion" | "formedContentSha256" | "factFrameFormation"
> {
  if (signal === undefined) return {};
  const raw = signal.raw_payload;
  const sourceAssertion = typeof raw.source_assertion === "string"
    ? raw.source_assertion
    : undefined;
  const content = {
    source_assertion: sourceAssertion ?? null,
    matched_text: typeof raw.matched_text === "string" ? raw.matched_text : null,
    distilled_fact: typeof raw.distilled_fact === "string" ? raw.distilled_fact : null,
    full_turn_content: typeof raw.full_turn_content === "string" ? raw.full_turn_content : null
  };
  return {
    ...(sourceAssertion === undefined ? {} : { sourceAssertion }),
    formedContentSha256: createHash("sha256")
      .update(JSON.stringify(content), "utf8")
      .digest("hex"),
    factFrameFormation: formFactFrameCommitment(signal)
  };
}

function semanticFactorGraphProjection(
  value: unknown
): Pick<ExtractionReplayEntry, "semanticFactorGraphProjection"> {
  const projection = parseOfficialApiSemanticFactorGraphProjectionAudit(value);
  return projection === null ? {} : { semanticFactorGraphProjection: projection };
}

function formFactFrameCommitment(
  signal: NonNullable<Parameters<typeof formationCommitment>[0]>
): Readonly<ExtractionReplayFactFrameFormation> {
  const evidence = buildEvidenceInput(signal, undefined, {
    fullTurnExcerpt: EXTRACTION_REPLAY_FORMATION_POLICY.fullTurnEvidence
  });
  const proposal = buildFactFrameFormationProposal(signal.raw_payload);
  const formation = materializeEvidenceFactFrameFormation({
    sourceAssertion: evidence.excerpt,
    sourceHash: evidence.source_hash,
    normalizer: RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER,
    ...(proposal === undefined ? {} : { proposal })
  });
  return Object.freeze({
    status: formation.capture.status,
    producerOperatorId: formation.capture.producer_operator_id,
    factKeyProjectionCount: formation.searchProjections.length,
    factKeyProjectionSha256: hashText(JSON.stringify(formation.searchProjections))
  });
}

function inspectOccurrenceShards(
  input: Parameters<typeof replayOccurrence>[0]
): readonly Readonly<{ cacheKey: string; inspection: CachedExtractionInspection }>[] {
  return input.occurrence.cacheKeys.map((cacheKey) => {
    if (input.semanticQuarantinedCacheKeys?.has(cacheKey) === true) {
      return { cacheKey, inspection: { status: "missing" as const } };
    }
    const existing = input.cached.get(cacheKey);
    if (existing !== undefined) return { cacheKey, inspection: existing };
    const inspection = inspectCachedExtraction(
      input.cacheRoot, cacheKey, input.model, input.requestProfile
    );
    input.cached.set(cacheKey, inspection);
    return { cacheKey, inspection };
  });
}

function unavailableOccurrence(
  occurrence: ExtractionOccurrence,
  cacheKey: string,
  cached: Exclude<CachedExtractionInspection, { readonly status: "hit" }>,
  allowMissing: boolean
): ExtractionReplayOccurrence {
  const prefix = cacheKey.slice(0, 12);
  const reason = cached.status === "missing"
    ? `shard_missing:${prefix}`
    : `shard_invalid:${prefix}:${cached.reason}`;
  return Object.freeze({
    occurrence,
    rawJsonSha256s: null,
    entries: Object.freeze([{
      index: -1,
      sourceCacheKey: cacheKey,
      disposition: cached.status === "missing" && allowMissing
        ? "deferred" as const
        : "invalid" as const,
      stage: "cache",
      reason
    }])
  });
}

function closeReplay(
  occurrences: readonly ExtractionReplayOccurrence[],
  factFramePolicy: ExtractionReplayResult["factFramePolicy"]
): ExtractionReplayResult["closure"] {
  const entries = occurrences.flatMap((occurrence) => occurrence.entries);
  const count = (disposition: ExtractionReplayDisposition) =>
    entries.filter((entry) => entry.disposition === disposition).length;
  return Object.freeze({
    occurrenceCount: occurrences.length,
    accountedOccurrences: occurrences.length,
    elementCount: entries.length,
    accountedElements: entries.length,
    admitted: count("admitted"),
    deferred: count("deferred"),
    rejected: count("rejected"),
    invalid: count("invalid"),
    ledgerSha256: hashReplayOccurrences(occurrences, factFramePolicy)
  });
}

function closeFactFrameFormations(
  occurrences: readonly ExtractionReplayOccurrence[]
): ExtractionReplayResult["factFrameClosure"] {
  const entries = occurrences.flatMap((occurrence) => occurrence.entries);
  const admitted = entries.filter(({ disposition }) => disposition === "admitted");
  const formations = admitted.flatMap((entry) =>
    entry.factFrameFormation === undefined ? [] : [entry.factFrameFormation]);
  if (formations.length !== admitted.length) {
    throw new Error("admitted extraction signal missing fact-frame formation commitment");
  }
  if (entries.some((entry) =>
    entry.disposition !== "admitted" && entry.factFrameFormation !== undefined)) {
    throw new Error("non-admitted extraction entry carries fact-frame formation commitment");
  }
  const count = (status: EvidenceFactFrameFormationStatus) =>
    formations.filter((formation) => formation.status === status).length;
  return Object.freeze({
    admittedSignalCount: admitted.length,
    accountedSignalCount: formations.length,
    formed: count("formed"),
    ineligible: count("ineligible"),
    unavailable: count("unavailable"),
    rejected: count("rejected"),
    factKeyProjectionCount: formations.reduce(
      (total, formation) => total + formation.factKeyProjectionCount,
      0
    )
  });
}

function replayScopedId(prefix: string, value: string): string {
  return `cache-audit-${prefix}-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function compareReplayOccurrences(
  left: ExtractionReplayOccurrence,
  right: ExtractionReplayOccurrence
): number {
  return left.occurrence.id.localeCompare(right.occurrence.id);
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
