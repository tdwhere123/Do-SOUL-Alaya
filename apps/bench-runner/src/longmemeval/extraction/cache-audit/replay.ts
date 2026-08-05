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
  buildFactFrameFormationProposal
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
  readonly disposition: ExtractionReplayDisposition;
  readonly stage: string;
  readonly reason: string;
  readonly sourceAssertion?: string;
  readonly formedContentSha256?: string;
  readonly factFrameFormation?: Readonly<ExtractionReplayFactFrameFormation>;
}

export interface ExtractionReplayOccurrence {
  readonly occurrence: ExtractionOccurrence;
  readonly rawJsonSha256: string | null;
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
    cache_key: occurrence.occurrence.cacheKey,
    source_observed_at: occurrence.occurrence.sourceObservedAt,
    raw_json_sha256: occurrence.rawJsonSha256,
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
}): ExtractionReplayOccurrence {
  const cached = cachedExtraction(input);
  if (cached.status !== "hit") return unavailableOccurrence(input.occurrence, cached);
  const result = input.audit({
    raw_json: cached.rawJson,
    turn_content: input.occurrence.turnContent,
    turn_messages: input.occurrence.turnMessages,
    workspace_id: replayScopedId("workspace", input.occurrence.id),
    run_id: replayScopedId("run", input.occurrence.id),
    surface_id: null,
    created_at: input.occurrence.sourceObservedAt,
    source_observed_at: input.occurrence.sourceObservedAt,
    require_source_observed_at: true,
    signal_id_for: (index) => replayScopedId("signal", `${input.occurrence.id}:${index}`)
  });
  return Object.freeze({
    occurrence: input.occurrence,
    rawJsonSha256: cached.rawJsonSha256,
    entries: Object.freeze(result.entries.map((entry) => Object.freeze({
      index: entry.index,
      disposition: entry.disposition,
      stage: entry.stage,
      reason: entry.reason,
      ...formationCommitment(entry.signal)
    })))
  });
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

function cachedExtraction(input: Parameters<typeof replayOccurrence>[0]): CachedExtractionInspection {
  const existing = input.cached.get(input.occurrence.cacheKey);
  if (existing !== undefined) return existing;
  const inspected = inspectCachedExtraction(
    input.cacheRoot, input.occurrence.cacheKey, input.model, input.requestProfile
  );
  input.cached.set(input.occurrence.cacheKey, inspected);
  return inspected;
}

function unavailableOccurrence(
  occurrence: ExtractionOccurrence,
  cached: Exclude<CachedExtractionInspection, { readonly status: "hit" }>
): ExtractionReplayOccurrence {
  const reason = cached.status === "missing" ? "shard_missing" : `shard_invalid:${cached.reason}`;
  return Object.freeze({
    occurrence,
    rawJsonSha256: null,
    entries: Object.freeze([{
      index: -1,
      disposition: "invalid" as const,
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
