import { z } from "zod";
import { AlayaError, canonicalJson, SourceSemanticAccessProfileSchema, SourceSemanticComparisonRequestSchema,
  SourceSemanticComparisonResponseSchema, type SourceRecordIdentity, type SourceSemanticAccessProfile,
  type SourceSemanticComparisonResponse } from "@do-soul/alaya-protocol";
import { admitSourceSemanticQuery, sourceSemanticQueryStatus, authorizedScopesFromAdmission,
  sourceSemanticAccessInputIdentity, sourceSemanticLibraryRequestIdentity, sourceSemanticLibraryQueryIdentity,
  preparedDeliveryId } from "@do-soul/alaya-core";
import type { BenchDaemonHandle } from "../../harness/daemon.js";
import { FirstExposurePageSchema, FirstExposureSession } from "../measurement/first-exposure-session.js";
import { recordSourceSemanticLibraryFirstExposure } from "../measurement/source-semantic-library-recall.js";
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

/** Temporary private comparison capture. No gold, model, public MCP call or policy selection.
 * The caller owns freezing the request/settings, artifact placement and runtime close evidence.
 * A captured page does not attest process or storage shutdown.
 */
export async function capturePrivateSourceLibrary(input: Readonly<{
  daemon: Pick<BenchDaemonHandle, "compareSourceSemantics">; request: unknown;
  profile: SourceSemanticAccessProfile; maxPages: 1 | 2;
}>) {
  const profile = SourceSemanticAccessProfileSchema.parse(structuredClone(input.profile));
  const request = SourceSemanticComparisonRequestSchema.parse(structuredClone(input.request));
  if (request.operation !== "recall" || request.continuation !== undefined || request.query_handle !== undefined ||
      input.maxPages !== 1 && input.maxPages !== 2) throw new AlayaError("VALIDATION", "private capture requires one fresh frozen library request");
  const execute = input.daemon.compareSourceSemantics;
  if (execute === undefined) throw new AlayaError("CONFLICT", "private source comparison was not enabled at startup");
  const session = new FirstExposureSession(), pages: z.infer<typeof CaptureSchema>["pages"] = [];
  let next = request;
  for (let page = 0; page < input.maxPages; page++) {
    let frame: z.infer<typeof FrameSchema> | undefined;
    const response = await execute({ request: next, ...(page === 0 ? { profile } : {}),
      capture: value => { frame = FrameSchema.parse(value); } });
    if (response.operation !== "recall" || frame === undefined || frame.response.operation !== "recall") {
      throw new AlayaError("CONFLICT", "private capture has no actual library output");
    }
    // Retain only validated JSON bytes; the shared exposure owner binds that same wire snapshot.
    const wire = FrameSchema.parse(JSON.parse(JSON.stringify(frame)));
    const first_exposure = recordSourceSemanticLibraryFirstExposure(response, session, next.continuation);
    pages.push({ ...wire, first_exposure });
    if (response.index.continuation === null) return CaptureSchema.parse({ contract: "source-semantic-private-library-capture-v1",
      profile, max_pages: input.maxPages, pages, stop: "no_issued_continuation" });
    const continuation = SourceSemanticComparisonRequestSchema.parse({ ...request, continuation: response.index.continuation });
    if (continuation.operation !== "recall") throw new AlayaError("CONFLICT", "private continuation kind changed");
    next = continuation;
  }
  return CaptureSchema.parse({ contract: "source-semantic-private-library-capture-v1", profile, max_pages: input.maxPages,
    pages, stop: "requested_page_bound" });
}

/** Whole private artifact admission before labels. Source/preview/proof verification is supplied
 * by the existing sealed-source owner, not inferred from an index or fabricated MCP envelope.
 * Consumer: the bounded comparison; promotion/termination removes the temporary private selector.
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
