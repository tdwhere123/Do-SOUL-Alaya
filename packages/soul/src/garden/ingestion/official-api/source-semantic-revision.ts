import { z } from "zod";
import {
  AlayaError, SourceAssertionIdSchema, SourceSemanticDiagnosticsSchema,
  materializeSourceSemanticContentProposal, materializeSourceSemanticExpressionProposal,
  materializeSourceSemanticCompactProposal, materializeSourceSemanticSelectionProposal,
  SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT, sourceSemanticValidationDiagnostics
} from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest, parseRetainedSourceSemanticRequest, sourceSemanticRequestCatalog, semanticSha256, type SourceSemanticRequest } from "./source-semantic-request.js";

const instruction = "Revise the previous proposal against the unchanged original source. Structural diagnostics describe rejected graph construction. Source review is an explicit reviewer interpretation, not an established fact; verify it against the source. Correct all supported content and scope, including omissions, without inventing facts. Return a complete new proposal, not a patch. The host will apply the same strict admission. Previous failures remain retained.";
const completedInstruction = "Revise the retained complete producer response against the unchanged original source. Diagnostics describe JSON syntax or rejected graph construction; transport completion does not imply valid JSON or faithful meaning. Source review is an explicit reviewer interpretation, not an established fact; verify it against the source. Return one complete JSON proposal matching the response schema, not a patch, while correcting supported content and scope without inventing facts. The host applies unchanged strict admission. Previous failures remain retained.";
const Digest = z.string().regex(/^[0-9a-f]{64}$/u);
const Review = z.array(z.object({
  assertion_ids: z.array(SourceAssertionIdSchema).min(1).max(8).readonly(),
  comment: z.string().min(1).max(2048)
}).strict().readonly()).max(32).readonly();

const revisionFields = {
  base_request_sha256: Digest, parent_request_sha256: Digest,
  parent_request_json: z.string().min(1).max(1_000_000),
  previous_response_sha256: Digest, previous_response: z.string().min(1).max(524288)
    .refine(value => value.trim().length > 0, { message: "revision requires a nonempty retained response" }),
  revision_number: z.number().int().min(1).max(3),
  structural_diagnostics: SourceSemanticDiagnosticsSchema,
  source_review: Review
};
/** Completion is caller-reported input, not an independently verified transport receipt. */
export const SourceSemanticRevisionSchema = z.discriminatedUnion("contract", [
  z.object({ contract: z.literal("source-semantic-revision-v1"), instruction: z.literal(instruction), ...revisionFields }).strict(),
  z.object({ contract: z.literal("source-semantic-revision-v2"), instruction: z.literal(completedInstruction),
    previous_response_completion: z.literal("complete"), ...revisionFields }).strict()
]).superRefine((revision, context) => {
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
  sourceReview: SourceSemanticRevision["source_review"] = [],
  options?: Readonly<{ responseCompletion: "complete" | "truncated" | "unknown" }>): SourceSemanticRevision {
  const request = parseSourceSemanticRequest(requestValue);
  if (request.source_request.proposal_contract !== "source-semantic-proposal-v2" &&
      request.source_request.proposal_contract !== "source-semantic-proposal-v3" &&
      request.source_request.proposal_contract !== "source-semantic-proposal-v4" &&
      request.source_request.proposal_contract !== SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT) {
    throw new AlayaError("VALIDATION", "revision requires the semantic content proposal contract");
  }
  if (Buffer.byteLength(previousResponse, "utf8") > 524288) throw new AlayaError("VALIDATION", "revision response exceeds its byte bound");
  if (options !== undefined && options.responseCompletion !== "complete") {
    throw new AlayaError("VALIDATION", "revision requires observed completion; truncated or unknown responses remain unrevisable");
  }
  const revision = SourceSemanticRevisionSchema.parse({
    ...(options === undefined ? { contract: "source-semantic-revision-v1", instruction }
      : { contract: "source-semantic-revision-v2", instruction: completedInstruction, previous_response_completion: "complete" }),
    base_request_sha256: sourceSemanticBaseRequestDigest(request),
    parent_request_sha256: semanticSha256(JSON.stringify(request)),
    parent_request_json: JSON.stringify(request),
    previous_response_sha256: semanticSha256(previousResponse), previous_response: previousResponse,
    revision_number: (request.source_request.revision?.revision_number ?? 0) + 1,
    structural_diagnostics: structuralDiagnostics(previousResponse, request, options !== undefined), source_review: sourceReview
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
  const parent = parseRetainedSourceSemanticRequest(parentValue);
  if (JSON.stringify(parent) !== revision.parent_request_json ||
      sourceSemanticBaseRequestDigest(parent) !== revision.base_request_sha256) {
    throw new AlayaError("CONFLICT", "revision parent has a different original request");
  }
  if (JSON.stringify(structuralDiagnostics(revision.previous_response, request, revision.contract === "source-semantic-revision-v2")) !== JSON.stringify(revision.structural_diagnostics)) {
    throw new AlayaError("CONFLICT", "revision structural diagnostics differ from retained raw validation");
  }
  const ids = new Set(request.source_request.source_assertions.map((row) => row.assertion_id));
  if (revision.source_review.some((row) => row.assertion_ids.some((id) => !ids.has(id)))) {
    throw new AlayaError("CONFLICT", "revision source review references an unselected assertion");
  }
}

function structuralDiagnostics(raw: string, request: SourceSemanticRequest, completeResponse = false): SourceSemanticRevision["structural_diagnostics"] {
  let previous: unknown;
  try { previous = JSON.parse(raw); }
  catch {
    if (!completeResponse) throw new AlayaError("VALIDATION", "revision requires a complete retained JSON response");
    return [{ code: "invalid_json", path: [], message: "The retained complete response is not valid JSON. Return one complete JSON proposal matching the response schema while preserving source content and scope." }];
  }
  try {
    if (request.source_request.proposal_contract === SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT) materializeSourceSemanticSelectionProposal(previous, { catalog: sourceSemanticRequestCatalog(request), sha256: semanticSha256 });
    else if (request.source_request.proposal_contract === "source-semantic-proposal-v4") materializeSourceSemanticCompactProposal(previous);
    else if (request.source_request.proposal_contract === "source-semantic-proposal-v3") materializeSourceSemanticExpressionProposal(previous);
    else materializeSourceSemanticContentProposal(previous);
  }
  catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return sourceSemanticValidationDiagnostics(error);
  }
  return [];
}
