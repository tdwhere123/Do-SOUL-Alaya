import { z } from "zod";
import { isCompleteSemanticFinish } from "../compile-seed/http/semantic-provider-http.js";
import type { ProviderRequestAttemptClass } from "../provider-request/execution.js";
import type { PageSupportComparisonLine } from "./input.js";
import {
  pageSupportOriginalIdentity, pageSupportQuoteOccurrences,
  type PageSupportOriginal, type PageSupportOriginalIdentity
} from "./original.js";

const QuoteSchema = z.object({
  source_index: z.number().int().nonnegative(),
  quote: z.string().min(1)
}).strict();

const ClaimSchema = z.object({
  claim: z.string().min(1),
  support: z.enum(["a_only", "b_only", "both"]),
  qualifications: z.array(z.string().min(1)),
  a_quotes: z.array(QuoteSchema).max(8),
  b_quotes: z.array(QuoteSchema).max(8),
  uncertainty: z.string().min(1)
}).strict();

const AnswerCompletenessSchema = z.enum(["complete", "partial", "none"]);

const ModelOutputSchema = z.object({
  status: z.enum(["assessed", "cannot_assess"]),
  claims: z.array(ClaimSchema).max(32),
  answer_a: AnswerCompletenessSchema,
  answer_b: AnswerCompletenessSchema,
  unresolved: z.array(z.string().min(1))
}).strict();

export type PageSupportComparisonFailureReason =
  | "malformed_json"
  | "invalid_shape"
  | "unusable_response"
  | "quote_mismatch"
  | "invalid_source_index"
  | "incoherent_support"
  | "abstain_has_claims"
  | "abstain_missing_unresolved"
  | "noncomplete";

export type PageSupportBoundQuote = Readonly<{
  source_index: number;
  quote: string;
  identity: PageSupportOriginalIdentity;
  occurrences: readonly { readonly start: number; readonly end: number }[];
}>;

export type PageSupportBoundClaim = Readonly<{
  claim: string;
  support: "a_only" | "b_only" | "both";
  qualifications: readonly string[];
  a_quotes: readonly PageSupportBoundQuote[];
  b_quotes: readonly PageSupportBoundQuote[];
  uncertainty: string;
}>;

export type PageSupportAssessed = Readonly<{
  status: "assessed";
  claims: readonly PageSupportBoundClaim[];
  answer_a: "complete" | "partial" | "none";
  answer_b: "complete" | "partial" | "none";
  unresolved: readonly string[];
}>;

export type PageSupportComparisonOutcome =
  | PageSupportAssessed
  | { readonly status: "abstained"; readonly unresolved: readonly string[] }
  | { readonly status: "invalid"; readonly reason: PageSupportComparisonFailureReason }
  | { readonly status: "incomplete"; readonly reason: "noncomplete" }
  | { readonly status: "transport_failure"; readonly failure?: unknown };

export function pageSupportComparisonResponseJsonSchema(): object {
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

export function interpretPageSupportComparisonDecoded(
  line: PageSupportComparisonLine,
  decoded: Readonly<{ rawJson: string; finishReason: string | null }>,
  requestProfile: string
): {
  classified: ProviderRequestAttemptClass;
  admitted: boolean;
  outcome: PageSupportComparisonOutcome;
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
    if (model.data.claims.length > 0) {
      return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason: "abstain_has_claims" } };
    }
    if (model.data.unresolved.length === 0) {
      return {
        classified: "terminal", admitted: false,
        outcome: { status: "invalid", reason: "abstain_missing_unresolved" }
      };
    }
    return {
      classified: "abstained", admitted: false,
      outcome: { status: "abstained", unresolved: model.data.unresolved }
    };
  }
  const bound = bindClaims(line, model.data.claims);
  if (bound.ok === false) {
    return { classified: "terminal", admitted: false, outcome: { status: "invalid", reason: bound.reason } };
  }
  // Quote admission proves attribution only. It is not entailment, irrelevance,
  // completeness, preservation, H/M/U, Q/H/C, or overall gain/loss.
  return {
    classified: "interpreted",
    admitted: true,
    outcome: {
      status: "assessed",
      claims: bound.claims,
      answer_a: model.data.answer_a,
      answer_b: model.data.answer_b,
      unresolved: model.data.unresolved
    }
  };
}

function bindClaims(
  line: PageSupportComparisonLine,
  claims: z.infer<typeof ModelOutputSchema>["claims"]
): { ok: true; claims: PageSupportBoundClaim[] } | { ok: false; reason: PageSupportComparisonFailureReason } {
  const bound: PageSupportBoundClaim[] = [];
  for (const claim of claims) {
    const aQuotes = bindArmQuotes(line.arm_a, claim.a_quotes);
    if (aQuotes.ok === false) return aQuotes;
    const bQuotes = bindArmQuotes(line.arm_b, claim.b_quotes);
    if (bQuotes.ok === false) return bQuotes;
    if (!supportMatchesQuotes(claim.support, aQuotes.quotes.length, bQuotes.quotes.length)) {
      return { ok: false, reason: "incoherent_support" };
    }
    bound.push({
      claim: claim.claim,
      support: claim.support,
      qualifications: claim.qualifications,
      a_quotes: aQuotes.quotes,
      b_quotes: bQuotes.quotes,
      uncertainty: claim.uncertainty
    });
  }
  return { ok: true, claims: bound };
}

function bindArmQuotes(
  arm: readonly PageSupportOriginal[],
  quotes: readonly { source_index: number; quote: string }[]
): { ok: true; quotes: PageSupportBoundQuote[] } | { ok: false; reason: PageSupportComparisonFailureReason } {
  const bound: PageSupportBoundQuote[] = [];
  for (const entry of quotes) {
    const original = arm[entry.source_index];
    if (original === undefined) return { ok: false, reason: "invalid_source_index" };
    const occurrences = pageSupportQuoteOccurrences(original.text, entry.quote, original.span.content_start);
    if (occurrences.length === 0) return { ok: false, reason: "quote_mismatch" };
    bound.push({
      source_index: entry.source_index,
      quote: entry.quote,
      identity: pageSupportOriginalIdentity(original),
      occurrences
    });
  }
  return { ok: true, quotes: bound };
}

function supportMatchesQuotes(
  support: "a_only" | "b_only" | "both", aCount: number, bCount: number
): boolean {
  if (support === "both") return aCount > 0 && bCount > 0;
  if (support === "a_only") return aCount > 0 && bCount === 0;
  return bCount > 0 && aCount === 0;
}
