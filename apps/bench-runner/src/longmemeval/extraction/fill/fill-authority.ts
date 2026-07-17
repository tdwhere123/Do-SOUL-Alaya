import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  ExtractionFillManifestContract,
  ExtractionFillSummaryContract
} from "./manifest/fill-manifest-contract.js";
import {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  extractionContentClosureEntriesFromIndex
} from "../content-closure.js";
import type { ExtractionRequestProfile } from "../request-profile.js";

export const EXTRACTION_FILL_IDENTITY_SCHEMA_FIELDS = {
  fill_status: z.enum(["in_progress", "complete"]).optional(),
  window_offset: z.number().int().nonnegative().optional(),
  window_limit: z.number().int().nonnegative().optional(),
  expected_turns: z.number().int().nonnegative().optional(),
  expected_key_set_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  content_closure_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional()
} as const;

export const EXTRACTION_FILL_AUTHORITY_SCHEMA_FIELDS = {
  ...EXTRACTION_FILL_IDENTITY_SCHEMA_FIELDS,
  content_closure_index: z.record(
    z.string().regex(/^[a-f0-9]{64}$/u),
    z.tuple([
      z.string().regex(/^[a-f0-9]{64}$/u),
      z.number().int().nonnegative(),
      z.number().int().nonnegative()
    ]).readonly()
  ).optional()
} as const;

interface ExtractionFillAuthorityEvidence extends ExtractionFillManifestContract {
  readonly extraction_model?: string;
  readonly request_profile?: ExtractionRequestProfile;
  readonly requested_turns?: number;
  readonly cached_turns?: number;
  readonly coverage?: number;
}

export function hasCompleteExtractionFillAuthority(
  evidence: ExtractionFillAuthorityEvidence
): evidence is ExtractionFillAuthorityEvidence &
  Required<ExtractionFillManifestContract> {
  return hasCompleteExtractionFillSummary(evidence) &&
    hasCompleteContentClosureIndex(evidence);
}

export function hasCompleteExtractionFillSummary(
  evidence: ExtractionFillAuthorityEvidence
): evidence is ExtractionFillAuthorityEvidence &
  Required<ExtractionFillSummaryContract> {
  return evidence.fill_status === "complete" &&
    isCount(evidence.window_offset) && isCount(evidence.window_limit) &&
    isCount(evidence.expected_turns) &&
    typeof evidence.expected_key_set_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(evidence.expected_key_set_sha256) &&
    typeof evidence.content_closure_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(evidence.content_closure_sha256) &&
    evidence.requested_turns === evidence.expected_turns &&
    evidence.cached_turns === evidence.expected_turns && evidence.coverage === 1;
}

function hasCompleteContentClosureIndex(
  evidence: ExtractionFillAuthorityEvidence
): boolean {
  const index = evidence.content_closure_index;
  if (typeof index !== "object" || index === null || Array.isArray(index) ||
      typeof evidence.extraction_model !== "string" ||
      evidence.request_profile === undefined ||
      !isCount(evidence.expected_turns) ||
      typeof evidence.expected_key_set_sha256 !== "string" ||
      typeof evidence.content_closure_sha256 !== "string") return false;
  try {
    const entries = extractionContentClosureEntriesFromIndex(
      index,
      evidence.extraction_model,
      evidence.request_profile
    );
    return entries.length === evidence.expected_turns &&
      computeExtractionKeySetSha256(Object.keys(index)) ===
        evidence.expected_key_set_sha256 &&
      computeExtractionContentClosureSha256(entries) ===
        evidence.content_closure_sha256;
  } catch {
    return false;
  }
}

export function hasMatchingCompleteExtractionFillAuthority(
  left: ExtractionFillAuthorityEvidence,
  right: ExtractionFillAuthorityEvidence
): boolean {
  return hasCompleteExtractionFillAuthority(left) &&
    hasCompleteExtractionFillAuthority(right) &&
    left.window_offset === right.window_offset &&
    left.window_limit === right.window_limit &&
    left.expected_turns === right.expected_turns &&
    left.expected_key_set_sha256 === right.expected_key_set_sha256 &&
    left.content_closure_sha256 === right.content_closure_sha256 &&
    isDeepStrictEqual(left.content_closure_index, right.content_closure_index);
}

export function hasMatchingCompleteExtractionFillSummary(
  left: ExtractionFillAuthorityEvidence,
  right: ExtractionFillAuthorityEvidence
): boolean {
  return hasCompleteExtractionFillSummary(left) &&
    hasCompleteExtractionFillSummary(right) &&
    left.window_offset === right.window_offset &&
    left.window_limit === right.window_limit &&
    left.expected_turns === right.expected_turns &&
    left.expected_key_set_sha256 === right.expected_key_set_sha256 &&
    left.content_closure_sha256 === right.content_closure_sha256;
}

export function containsExtractionFillQuestionWindow(
  evidence: ExtractionFillManifestContract,
  offset: number,
  limit: number
): boolean {
  if (!isCount(evidence.window_offset) || !isCount(evidence.window_limit) ||
    !isCount(offset) || !isCount(limit)) return false;
  const relativeOffset = offset - evidence.window_offset;
  return relativeOffset >= 0 &&
    limit <= evidence.window_limit - relativeOffset;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
