import { sourceSemanticGenerationTaskSummary } from "@do-soul/alaya-protocol";
import {
  parseSourceSemanticRequest, sourceSemanticResponseJsonSchema, type SourceSemanticRequest
} from "./source-semantic-request.js";

/** Provider presentation is derived from the complete retained host request. */
export function sourceSemanticGenerationInput(requestValue: SourceSemanticRequest): string {
  const request = parseSourceSemanticRequest(requestValue);
  const source = request.source_request;
  if (source.generation_view_contract === undefined) return JSON.stringify(request);
  const exhaustive = source.generation_task?.responsibility.kind === "all_supplied_meaning";
  let revision: Omit<NonNullable<typeof source.revision>, "parent_request_json"> | undefined = source.revision;
  if (exhaustive && source.revision !== undefined) {
    // Retained host ancestry includes task cues; model feedback needs no serialized host request.
    const { parent_request_json: _hostParent, ...feedback } = source.revision;
    revision = feedback;
  }
  return JSON.stringify({
    contract: source.generation_view_contract,
    response_schema: sourceSemanticResponseJsonSchema(request),
    source_request: {
      ...(source.source_scope === undefined ? {} : { source_scope: source.source_scope }),
      resource_limits: source.resource_limits,
      attribution_context: source.attribution_context,
      ...(source.attribution_context.status === "captured" ? { assertion_locations: source.assertion_locations } : {}),
      source_assertions: source.source_assertions,
      ...(source.generation_task === undefined ? {} : {
        generation_task: exhaustive ? sourceSemanticGenerationTaskSummary(source.generation_task) : source.generation_task,
        original_source: source.original_source
      }),
      ...(revision === undefined ? {} : { revision })
    },
    ...(request.profile === undefined ? {} : { profile: request.profile })
  });
}

/** Generic extraction codecs retain historical prompts and validate selected host requests. */
export function sourceSemanticGenerationPresentation(hostRequestJson: string) {
  let value: unknown;
  try { value = JSON.parse(hostRequestJson); }
  catch { return undefined; }
  if (value === null || typeof value !== "object" || !("source_request" in value)) return undefined;
  const source = value.source_request;
  if (source === null || typeof source !== "object" || !("generation_view_contract" in source)) return undefined;
  const request = parseSourceSemanticRequest(value);
  return {
    contract: request.source_request.generation_view_contract!,
    modelInputJson: sourceSemanticGenerationInput(request),
    responseJsonSchema: sourceSemanticResponseJsonSchema(request)
  };
}
