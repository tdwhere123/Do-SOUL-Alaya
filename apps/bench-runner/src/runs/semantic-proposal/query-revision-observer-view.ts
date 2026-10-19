import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import type { SourceSemanticQueryRequest } from "@do-soul/alaya-soul";
import { z } from "zod";

const LocationSchema = z.object({
  document: z.enum(["parent_request", "previous_response"]),
  pointer: z.string().min(1).max(256).regex(/^\/(?:[^~]|~[01])*$/u)
}).strict().readonly();
const ObserverViewSchema = z.object({
  kind: z.literal("observer-authored-mechanical-observations"),
  parent_key: z.string().regex(/^[0-9a-f]{64}$/u),
  parent_request_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  parent_request_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  previous_response_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  observations: z.array(z.object({
    locations: z.array(LocationSchema).min(1).max(4).readonly(),
    text: z.string().min(1).max(1024),
    provenance: z.string().min(1).max(256)
  }).strict().refine(observation => observation.locations.some(location => location.document === "previous_response"),
    "observer observations require a retained response location").readonly()).min(1).max(8).readonly()
}).strict().readonly();

/** App-private generation treatment, never a workset/revision selector or Core diagnostic. */
export type QueryRevisionObserverView = z.infer<typeof ObserverViewSchema>;

/** Capture once for the two one-item study arms; resupply this value for fill and recovery. */
export function captureQueryRevisionObserverView(value: unknown): QueryRevisionObserverView {
  const view = ObserverViewSchema.parse(structuredClone(value));
  if (Buffer.byteLength(canonicalJson(view), "utf8") > 16_384) {
    throw new AlayaError("VALIDATION", "query revision observer view exceeds its byte bound");
  }
  return view;
}

/** Validate transport binding/locations only, not the observer's correctness or absence of gold. */
export function queryRevisionObserverGuidance(request: SourceSemanticQueryRequest, value: QueryRevisionObserverView,
  parent: Readonly<{ key: string; requestDigest: string }>): string {
  const view = captureQueryRevisionObserverView(value), revision = request.revision;
  if (revision === undefined || revision.kind !== "query" || revision.revision_number !== 1 ||
      revision.review_comments.length !== 0 || revision.attention_request_sha256 !== undefined ||
      view.parent_key !== parent.key || view.parent_request_digest !== parent.requestDigest ||
      view.parent_request_sha256 !== revision.parent_request_sha256 ||
      view.previous_response_sha256 !== revision.previous_response_sha256) {
    throw new AlayaError("CONFLICT", "query revision observer view does not bind this original parent and response");
  }
  let previous: unknown;
  try { previous = JSON.parse(revision.previous_response); }
  catch { throw new AlayaError("VALIDATION", "query revision observer locations require a JSON parent response"); }
  for (const observation of view.observations) {
    for (const location of observation.locations) {
      if (location.document === "parent_request") {
        if (location.pointer !== "/original_query") {
          throw new AlayaError("VALIDATION", "query revision observer may locate only the original question in its parent request");
        }
      } else assertResponseLocation(previous, location.pointer);
    }
  }
  return "\n\nAPP-PRIVATE EXPERIMENT: observer-authored mechanical observations for this query revision. " +
    "These observations are fallible, may be wrong, and are not native Core diagnostics or authoritative failure reasons. " +
    "They describe only the original question and exact retained previous response, not source evidence or an evaluator answer. " +
    "Reconsider them against those unchanged inputs. Return one complete proposal under the unchanged schema and admission; " +
    "no observation certifies semantic fidelity.\n" + canonicalJson(view);
}

function assertResponseLocation(value: unknown, pointer: string): void {
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key) ||
        Array.isArray(current) && !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new AlayaError("VALIDATION", "query revision observer location is absent from the exact retained response");
    }
    current = (current as Record<string, unknown>)[key];
  }
}
