import { z } from "zod";
import { AlayaError, canonicalJson, SourceSemanticAccessProfileSchema, SourceSemanticComparisonRequestSchema,
  SourceSemanticComparisonResponseSchema, type SourceRecordIdentity, type SourceSemanticAccessProfile,
  type SourceSemanticComparisonResponse } from "@do-soul/alaya-protocol";
import { admitSourceSemanticQuery, sourceSemanticQueryStatus, authorizedScopesFromAdmission,
  sourceSemanticAccessInputIdentity, sourceSemanticLibraryRequestIdentity, sourceSemanticLibraryQueryIdentity,
  preparedDeliveryId } from "@do-soul/alaya-core";
import { FirstExposurePageSchema } from "../measurement/first-exposure-session.js";
import { admitSourceSemanticLibraryResponse, admitSourceSemanticLibraryContinuation } from "../measurement/source-semantic-library-measurement.js";

type Recall = Extract<SourceSemanticComparisonResponse, { operation: "recall" }>;
const FrameSchema = z.object({
  entry: z.literal("private_source_comparison"),
  context: z.object({ workspace_id: z.string().min(1), run_id: z.string().nullable(), session_id: z.string().min(1), agent_target: z.string().min(1) }).strict(),
  request: SourceSemanticComparisonRequestSchema, response: SourceSemanticComparisonResponseSchema
}).strict();
const CaptureSchema = z.object({ contract: z.literal("source-semantic-private-library-capture-v1"),
  profile: SourceSemanticAccessProfileSchema, max_pages: z.union([z.literal(1), z.literal(2)]),
  pages: z.array(FrameSchema.extend({ first_exposure: FirstExposurePageSchema })).min(1).max(2),
  stop: z.enum(["requested_page_bound", "no_issued_continuation"])
}).strict();

/** Whole private artifact admission before labels. Source/preview/proof verification is supplied
 * by the existing sealed-source owner, not inferred from an index or fabricated MCP envelope.
 * Consumer: historical private comparison archives. Keep admission and identity meanings
 * while those archives are supported; this module cannot initiate a live comparison.
 */
export function admitPrivateSourceLibraryCapture(raw: unknown, input: Readonly<{
  workspace_id: string; run_id: string | null; as_of: string; request: unknown; profile: SourceSemanticAccessProfile;
  verifySources: (response: Recall) => readonly SourceRecordIdentity[];
}>) {
  const capture = CaptureSchema.parse(raw), expected = SourceSemanticComparisonRequestSchema.parse(input.request);
  const profile = SourceSemanticAccessProfileSchema.parse(input.profile);
  if (expected.operation !== "recall" || canonicalJson(profile) !== canonicalJson(capture.profile)) {
    throw new AlayaError("CONFLICT", "private capture request/profile changed");
  }
  const pages: { response: Recall; records: readonly SourceRecordIdentity[] }[] = [];
  let previous: Parameters<typeof admitSourceSemanticLibraryResponse>[0] | undefined;
  let previousResponse: Recall | undefined;
  let context: z.infer<typeof FrameSchema>["context"] | undefined;
  for (const [position, page] of capture.pages.entries()) {
    if (page.request.operation !== "recall" || page.response.operation !== "recall" ||
        page.context.workspace_id !== input.workspace_id || page.context.run_id !== input.run_id ||
        context !== undefined && canonicalJson(context) !== canonicalJson(page.context)) {
      throw new AlayaError("CONFLICT", "private capture lacks its actual bound context");
    }
    context = page.context;
    const request = page.request, response = page.response;
    const expectedRequest = position === 0 ? expected : { ...expected, continuation: previousResponse!.index.continuation };
    if (canonicalJson(request) !== canonicalJson(expectedRequest)) throw new AlayaError("CONFLICT", "private capture request changed");
    if (response.index.as_of !== input.as_of) throw new AlayaError("CONFLICT", "private capture clock changed");
    admitBinding(request, response, profile, input.workspace_id);
    const current = { recallResult: response, firstExposurePage: page.first_exposure, requestBudget: request.budget };
    const admitted = previous === undefined ? admitSourceSemanticLibraryResponse(current)
      : admitSourceSemanticLibraryContinuation({ ...current, previous, requestContinuation: request.continuation!, requestIdentity: response.request_identity });
    if (admitted?.status !== "admitted") throw new AlayaError("CONFLICT", "private library exposure is invalid or unavailable");
    const records = input.verifySources(response);
    for (const entry of response.index.entries) {
      const target = entry.target;
      if (target.kind !== "source_evidence" || !records.some(record => record.workspace_id === target.workspace_id &&
          record.identity === target.root_id && record.source_version === target.source_version && record.content_digest === target.content_digest)) {
        throw new AlayaError("CONFLICT", "private delivery lacks sealed current source verification");
      }
    }
    pages.push({ response, records }); previous = current; previousResponse = response;
  }
  if (capture.stop === "no_issued_continuation" ? previousResponse!.index.continuation !== null
    : capture.pages.length !== capture.max_pages || previousResponse!.index.continuation === null) {
    throw new AlayaError("CONFLICT", "private capture stop contradicts actual continuation");
  }
  return { status: "admitted" as const, capture, pages };
}

function admitBinding(request: Extract<z.infer<typeof SourceSemanticComparisonRequestSchema>, { operation: "recall" }>,
  response: Recall, profile: SourceSemanticAccessProfile, workspace: string): void {
  const scopes = authorizedScopesFromAdmission(request.authorized_scopes ?? { mode: "unrestricted" }).authorized_scopes;
  if (scopes === undefined || request.original_query === undefined) throw new AlayaError("CONFLICT", "private capture has no frozen original query/scope");
  const query = admitSourceSemanticQuery(request.query_semantics, request.original_query);
  const admitted = query.kind === "admitted" ? query.query : undefined;
  const status = sourceSemanticQueryStatus(query, request.query_semantics_unavailable);
  const identity = sourceSemanticLibraryRequestIdentity({ workspace_id: workspace, as_of: response.index.as_of!, authorized_scopes: scopes,
    original_query: request.original_query, query_semantics: admitted, query_semantics_status: status,
    semantic_correspondences: request.semantic_correspondences ?? [], budget: request.budget,
    output_byte_limit: request.output_byte_limit, candidate_profile: profile });
  if (canonicalJson(response.discovery.access.profile) !== canonicalJson(profile) ||
      canonicalJson(response.query_semantics_status) !== canonicalJson(status) || response.request_identity !== identity ||
      response.delivery_id !== preparedDeliveryId(identity, response.index) ||
      response.index.query_id !== sourceSemanticLibraryQueryIdentity(request.original_query, profile.result_version) ||
      response.discovery.access.input_id !== sourceSemanticAccessInputIdentity({ original_query: request.original_query,
        query_semantics: admitted, budget: request.budget, candidate_profile: profile })) {
    throw new AlayaError("CONFLICT", "private library response does not bind the frozen request/profile");
  }
}
