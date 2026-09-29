import { z } from "zod";
import { SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET } from "@do-soul/alaya-protocol";
import { isCompleteSemanticFinish } from "../compile-seed/http/semantic-provider-http.js";
import type { ProviderRequestAttemptClass } from "../provider-request/execution.js";
import type { SourceEvidencePreservationLine } from "./input.js";
import {
  sourceEvidencePreservationIdentity, sourceEvidencePreservationQuoteOccurrences,
  type SourceEvidencePreservationIdentity, type SourceEvidencePreservationOriginal
} from "./original.js";

const CandidateCitationSchema = z.object({
  root_id: z.string().min(1),
  quotes: z.array(z.string().min(1)).min(1).max(3)
}).strict();

const RetainedRecordSchema = z.object({
  root_id: z.string().min(1),
  disposition: z.literal("retained"),
  reference_quotes: z.array(z.string().min(1)).min(1).max(3),
  candidate_citations: z.array(CandidateCitationSchema).min(1).max(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET)
}).strict();

const ReasonRecordSchema = z.object({
  root_id: z.string().min(1),
  disposition: z.enum(["loss", "material_comparison_unknown", "not_relevant"]),
  reason: z.string().min(1)
}).strict();

const ModelOutputSchema = z.object({
  status: z.enum(["preserved", "lost", "unresolved", "cannot_assess"]),
  records: z.array(z.union([RetainedRecordSchema, ReasonRecordSchema])).max(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET),
  answer_uncertainties: z.array(z.string().min(1))
}).strict();

export type SourceEvidencePreservationFailureReason =
  | "malformed_json"
  | "invalid_shape"
  | "unusable_response"
  | "unknown_root"
  | "duplicate_root"
  | "omitted_root"
  | "quote_mismatch"
  | "incoherent_status"
  | "empty_preserved"
  | "abstain_has_records"
  | "abstain_missing_unresolved"
  | "noncomplete";

export type SourceEvidencePreservationQuoteMatch = Readonly<{
  quote: string;
  occurrences: readonly { readonly start: number; readonly end: number }[];
}>;

export type SourceEvidencePreservationBoundCitation = Readonly<{
  root_id: string;
  identity: SourceEvidencePreservationIdentity;
  quotes: readonly SourceEvidencePreservationQuoteMatch[];
}>;

export type SourceEvidencePreservationBoundRecord =
  | {
      readonly root_id: string;
      readonly disposition: "retained";
      readonly identity: SourceEvidencePreservationIdentity;
      readonly reference_quotes: readonly SourceEvidencePreservationQuoteMatch[];
      readonly candidate_citations: readonly SourceEvidencePreservationBoundCitation[];
    }
  | {
      readonly root_id: string;
      readonly disposition: "loss" | "material_comparison_unknown" | "not_relevant";
      readonly reason: string;
      readonly identity: SourceEvidencePreservationIdentity;
    };

export type SourceEvidencePreservationAssessed = Readonly<{
  status: "preserved" | "lost" | "unresolved";
  records: readonly SourceEvidencePreservationBoundRecord[];
  answer_uncertainties: readonly string[];
}>;

export type SourceEvidencePreservationOutcome =
  | SourceEvidencePreservationAssessed
  | { readonly status: "abstained"; readonly answer_uncertainties: readonly string[] }
  | { readonly status: "invalid"; readonly reason: SourceEvidencePreservationFailureReason }
  | { readonly status: "incomplete"; readonly reason: "noncomplete" }
  | { readonly status: "transport_failure"; readonly failure?: unknown };

export type SourceEvidencePreservationDeliveryReason =
  | "preserved"
  | "loss"
  | "unresolved"
  | "invalid"
  | "unavailable"
  | "abstained"
  | "incomplete";

export type SourceEvidencePreservationDelivery = Readonly<{
  delivery: "candidate" | "baseline";
  reason: SourceEvidencePreservationDeliveryReason;
  allows_checked_candidate: boolean;
  baseline: readonly SourceEvidencePreservationOriginal[];
  candidate_originals: readonly SourceEvidencePreservationOriginal[];
  invalid_reason?: SourceEvidencePreservationFailureReason;
  assessment?: SourceEvidencePreservationAssessed;
}>;

export function sourceEvidencePreservationResponseJsonSchema(): object {
  return z.toJSONSchema(ModelOutputSchema, {
    io: "output",
    reused: "inline",
    override: ({ jsonSchema }) => {
      if (jsonSchema.const !== undefined) {
        jsonSchema.enum = [jsonSchema.const];
        delete jsonSchema.const;
      }
    }
  });
}

export function interpretSourceEvidencePreservationDecoded(
  line: SourceEvidencePreservationLine,
  decoded: Readonly<{ rawJson: string; finishReason: string | null }>,
  requestProfile: string
): {
  classified: ProviderRequestAttemptClass;
  admitted: boolean;
  outcome: SourceEvidencePreservationOutcome;
} {
  if (!isCompleteSemanticFinish(requestProfile, decoded.finishReason)) {
    return { classified: "incomplete", admitted: false, outcome: { status: "incomplete", reason: "noncomplete" } };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(decoded.rawJson); }
  catch {
    return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason: "malformed_json" } };
  }
  const model = ModelOutputSchema.safeParse(parsed);
  if (!model.success) {
    return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason: "invalid_shape" } };
  }
  if (model.data.status === "cannot_assess") {
    if (model.data.records.length > 0) {
      return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason: "abstain_has_records" } };
    }
    if (model.data.answer_uncertainties.length === 0) {
      return {
        classified: "terminal", admitted: false,
        outcome: { status: "invalid", reason: "abstain_missing_unresolved" }
      };
    }
    return {
      classified: "abstained", admitted: false,
      outcome: { status: "abstained", answer_uncertainties: model.data.answer_uncertainties }
    };
  }
  const bound = bindReferenceRecords(line, model.data.records);
  if (bound.ok === false) {
    return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason: bound.reason } };
  }
  if (!statusMatchesDispositions(model.data.status, bound.records) ||
      model.data.status === "preserved" && line.candidate_originals.length === 0) {
    const reason = model.data.status === "preserved" &&
      !bound.records.some((record) => record.disposition === "retained")
      ? "empty_preserved" : "incoherent_status";
    return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason } };
  }
  return {
    classified: "interpreted",
    admitted: true,
    outcome: {
      status: model.data.status,
      records: bound.records,
      answer_uncertainties: model.data.answer_uncertainties
    }
  };
}

/** Host fallback. Does not judge semantic truth; invalid or unavailable keep the captured baseline. */
export function settleSourceEvidencePreservationDelivery(input: Readonly<{
  references: readonly SourceEvidencePreservationOriginal[];
  candidates: readonly SourceEvidencePreservationOriginal[];
  outcome: SourceEvidencePreservationOutcome;
}>): SourceEvidencePreservationDelivery {
  const baseline = Object.freeze(structuredClone(input.references));
  const candidate_originals = Object.freeze(structuredClone(input.candidates));
  if (input.outcome.status === "preserved") {
    return {
      delivery: "candidate", reason: "preserved", allows_checked_candidate: true,
      baseline, candidate_originals, assessment: input.outcome
    };
  }
  if (input.outcome.status === "lost" || input.outcome.status === "unresolved") {
    return {
      delivery: "baseline",
      reason: input.outcome.status === "lost" ? "loss" : "unresolved",
      allows_checked_candidate: false,
      baseline, candidate_originals, assessment: input.outcome
    };
  }
  if (input.outcome.status === "abstained") {
    return { delivery: "baseline", reason: "abstained", allows_checked_candidate: false, baseline, candidate_originals };
  }
  if (input.outcome.status === "incomplete") {
    return { delivery: "baseline", reason: "incomplete", allows_checked_candidate: false, baseline, candidate_originals };
  }
  if (input.outcome.status === "transport_failure") {
    return { delivery: "baseline", reason: "unavailable", allows_checked_candidate: false, baseline, candidate_originals };
  }
  return {
    delivery: "baseline", reason: "invalid", allows_checked_candidate: false,
    baseline, candidate_originals,
    ...(input.outcome.status === "invalid" ? { invalid_reason: input.outcome.reason } : {})
  };
}

function bindReferenceRecords(
  line: SourceEvidencePreservationLine,
  records: z.infer<typeof ModelOutputSchema>["records"]
): { ok: true; records: SourceEvidencePreservationBoundRecord[] } | { ok: false; reason: SourceEvidencePreservationFailureReason } {
  const references = new Map(line.reference_originals.map((original) => [original.root_id, original]));
  if (references.size !== line.reference_originals.length) {
    return { ok: false, reason: "duplicate_root" };
  }
  const candidates = new Map(line.candidate_originals.map((original) => [original.root_id, original]));
  if (candidates.size !== line.candidate_originals.length) {
    return { ok: false, reason: "duplicate_root" };
  }
  const seen = new Set<string>();
  const bound: SourceEvidencePreservationBoundRecord[] = [];
  for (const record of records) {
    if (seen.has(record.root_id)) return { ok: false, reason: "duplicate_root" };
    seen.add(record.root_id);
    const reference = references.get(record.root_id);
    if (reference === undefined) return { ok: false, reason: "unknown_root" };
    const identity = sourceEvidencePreservationIdentity(reference);
    if (record.disposition !== "retained") {
      bound.push({ root_id: record.root_id, disposition: record.disposition, reason: record.reason, identity });
      continue;
    }
    const retained = bindRetainedRecord(candidates, reference, record);
    if (retained.ok === false) return retained;
    bound.push(retained.record);
  }
  if (seen.size !== references.size) return { ok: false, reason: "omitted_root" };
  return { ok: true, records: bound };
}

function bindRetainedRecord(
  candidates: ReadonlyMap<string, SourceEvidencePreservationOriginal>,
  reference: SourceEvidencePreservationOriginal,
  record: z.infer<typeof RetainedRecordSchema>
): { ok: true; record: Extract<SourceEvidencePreservationBoundRecord, { disposition: "retained" }> }
  | { ok: false; reason: SourceEvidencePreservationFailureReason } {
  const referenceQuotes = bindExplicitQuotes(reference, record.reference_quotes);
  if (referenceQuotes === undefined) return { ok: false, reason: "quote_mismatch" };
  const seen = new Set<string>();
  const citations: SourceEvidencePreservationBoundCitation[] = [];
  for (const citation of record.candidate_citations) {
    if (seen.has(citation.root_id)) return { ok: false, reason: "duplicate_root" };
    seen.add(citation.root_id);
    const candidate = candidates.get(citation.root_id);
    if (candidate === undefined) return { ok: false, reason: "unknown_root" };
    const quotes = bindExplicitQuotes(candidate, citation.quotes);
    if (quotes === undefined) return { ok: false, reason: "quote_mismatch" };
    citations.push({
      root_id: citation.root_id,
      identity: sourceEvidencePreservationIdentity(candidate),
      quotes
    });
  }
  if (citations.length === 0) return { ok: false, reason: "quote_mismatch" };
  return {
    ok: true,
    record: {
      root_id: record.root_id,
      disposition: "retained",
      identity: sourceEvidencePreservationIdentity(reference),
      reference_quotes: referenceQuotes,
      candidate_citations: citations
    }
  };
}

function bindExplicitQuotes(
  original: SourceEvidencePreservationOriginal, quotes: readonly string[]
): SourceEvidencePreservationQuoteMatch[] | undefined {
  const bound: SourceEvidencePreservationQuoteMatch[] = [];
  for (const quote of quotes) {
    const occurrences = sourceEvidencePreservationQuoteOccurrences(
      original.text, quote, original.span.content_start
    );
    if (occurrences.length === 0) return undefined;
    bound.push({ quote, occurrences });
  }
  return bound;
}

function statusMatchesDispositions(
  status: "preserved" | "lost" | "unresolved",
  records: readonly SourceEvidencePreservationBoundRecord[]
): boolean {
  const hasLoss = records.some((record) => record.disposition === "loss");
  const hasUnknown = records.some((record) => record.disposition === "material_comparison_unknown");
  const hasRetained = records.some((record) => record.disposition === "retained");
  if (status === "preserved") return !hasLoss && !hasUnknown && hasRetained;
  if (status === "lost") return hasLoss && !hasUnknown;
  return hasUnknown;
}
