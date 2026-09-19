import { z } from "zod";
import {
  AlayaError, SourceAssertionIdSchema, SourceSemanticDiagnosticsSchema,
  materializeSourceSemanticContentProposal, sourceSemanticValidationDiagnostics
} from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest, semanticSha256, type SourceSemanticRequest } from "./source-semantic-request.js";

const instruction = "Revise the previous proposal against the unchanged original source. Structural diagnostics describe rejected graph construction. Source review is an explicit reviewer interpretation, not an established fact; verify it against the source. Correct all supported content and scope, including omissions, without inventing facts. Return a complete new proposal, not a patch. The host will apply the same strict admission. Previous failures remain retained.";
const Digest = z.string().regex(/^[0-9a-f]{64}$/u);
const Review = z.array(z.object({
  assertion_ids: z.array(SourceAssertionIdSchema).min(1).max(8).readonly(),
  comment: z.string().min(1).max(2048)
}).strict().readonly()).max(32).readonly();

/** Revision metadata is request input, never semantic evidence or a truth claim. */
export const SourceSemanticRevisionSchema = z.object({
  contract: z.literal("source-semantic-revision-v1"), instruction: z.literal(instruction),
  base_request_sha256: Digest, parent_request_sha256: Digest,
  parent_request_json: z.string().min(1).max(1_000_000),
  previous_response_sha256: Digest, previous_response: z.string().min(1).max(524288),
  revision_number: z.number().int().min(1).max(3),
  structural_diagnostics: SourceSemanticDiagnosticsSchema,
  source_review: Review
}).strict().superRefine((revision, context) => {
  if (semanticSha256(revision.previous_response) !== revision.previous_response_sha256) {
    context.addIssue({ code: "custom", message: "revision response digest mismatch" });
  }
}).readonly();
export type SourceSemanticRevision = z.infer<typeof SourceSemanticRevisionSchema>;

export function sourceSemanticBaseRequestDigest(request: SourceSemanticRequest): string {
  const { revision: _revision, ...source_request } = request.source_request;
  return semanticSha256(JSON.stringify({ ...request, source_request }));
}

/** Provider-free preparation only; the caller owns explicit native attempt/cost authorization. */
export function prepareSourceSemanticRevision(requestValue: SourceSemanticRequest, previousResponse: string,
  sourceReview: SourceSemanticRevision["source_review"] = []): SourceSemanticRevision {
  const request = parseSourceSemanticRequest(requestValue);
  if (request.source_request.proposal_contract !== "source-semantic-proposal-v2") {
    throw new AlayaError("VALIDATION", "revision requires the semantic content proposal contract");
  }
  if (Buffer.byteLength(previousResponse, "utf8") > 524288) throw new AlayaError("VALIDATION", "revision response exceeds its byte bound");
  const revision = SourceSemanticRevisionSchema.parse({
    contract: "source-semantic-revision-v1", instruction,
    base_request_sha256: sourceSemanticBaseRequestDigest(request),
    parent_request_sha256: semanticSha256(JSON.stringify(request)),
    parent_request_json: JSON.stringify(request),
    previous_response_sha256: semanticSha256(previousResponse), previous_response: previousResponse,
    revision_number: (request.source_request.revision?.revision_number ?? 0) + 1,
    structural_diagnostics: structuralDiagnostics(previousResponse), source_review: sourceReview
  });
  validateSourceSemanticRevision(request, revision);
  return revision;
}

export function validateSourceSemanticRevision(request: SourceSemanticRequest, revision: SourceSemanticRevision): void {
  if (sourceSemanticBaseRequestDigest(request) !== revision.base_request_sha256) {
    throw new AlayaError("CONFLICT", "revision belongs to a different original source request");
  }
  if (Buffer.byteLength(revision.previous_response, "utf8") > 524288 ||
      Buffer.byteLength(revision.parent_request_json, "utf8") > 1_000_000 ||
      semanticSha256(revision.parent_request_json) !== revision.parent_request_sha256) {
    throw new AlayaError("CONFLICT", "revision parent identity or byte bound mismatch");
  }
  let parentValue: unknown;
  try { parentValue = JSON.parse(revision.parent_request_json); }
  catch { throw new AlayaError("VALIDATION", "revision parent request is not JSON"); }
  // Check descending depth before recursive validation; the public cap is three.
  const parentNumber = (parentValue as SourceSemanticRequest)?.source_request?.revision?.revision_number ?? 0;
  if (parentNumber !== revision.revision_number - 1) throw new AlayaError("CONFLICT", "revision does not follow its immediate parent");
  const parent = parseSourceSemanticRequest(parentValue);
  if (JSON.stringify(parent) !== revision.parent_request_json ||
      sourceSemanticBaseRequestDigest(parent) !== revision.base_request_sha256) {
    throw new AlayaError("CONFLICT", "revision parent has a different original request");
  }
  if (JSON.stringify(structuralDiagnostics(revision.previous_response)) !== JSON.stringify(revision.structural_diagnostics)) {
    throw new AlayaError("CONFLICT", "revision structural diagnostics differ from retained raw validation");
  }
  const ids = new Set(request.source_request.source_assertions.map((row) => row.assertion_id));
  if (revision.source_review.some((row) => row.assertion_ids.some((id) => !ids.has(id)))) {
    throw new AlayaError("CONFLICT", "revision source review references an unselected assertion");
  }
}

function structuralDiagnostics(raw: string): SourceSemanticRevision["structural_diagnostics"] {
  let previous: unknown;
  try { previous = JSON.parse(raw); }
  catch { throw new AlayaError("VALIDATION", "revision requires a complete retained JSON response"); }
  try { materializeSourceSemanticContentProposal(previous); }
  catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return sourceSemanticValidationDiagnostics(error);
  }
  return [];
}
