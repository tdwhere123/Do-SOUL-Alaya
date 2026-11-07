import { createHash } from "node:crypto";
import { z } from "zod";
import { SOURCE_TASK_OBSERVATION_PRODUCER_ID, SourceTaskObservationDraftSchema,
  SourceTaskObservationFormationInputSchema, SourceTaskObservationProposalSchema, canonicalJson, compareUtcInstants,
  type SourceTaskObservation, type SourceTaskObservationFormationInput } from "@do-soul/alaya-protocol";
import { buildObservationEndpointCatalogs, resolveObservationEndpointSelection } from "./endpoint-selection.js";
import { isCompleteSemanticFinish } from "../compile-seed/http/semantic-provider-http.js";

/** Fresh wire/cache identity: previous observation requests and their raw attempts are not reusable. */
export const SOURCE_TASK_OBSERVATION_FORMATION_ID = "source-task-observation.endpoint-selection.v7";

export const SOURCE_TASK_OBSERVATION_SYSTEM_PROMPT = `Describe source-local task evidence, not an answer or ranking.
For each source, explicitly choose an association_ref from its endpoint_catalog.associations for the asked event or task input under the supplied Q/H/C hypothesis. Select a temporal_operand_ref only from endpoint_catalog.temporal_operands on that association's exact source_frame. Use status selected and its supplied ref, or status missing (prerequisites/operand absent), unresolved (meaning uncertain), or ambiguous (multiple choices cannot be distinguished) with a null ref. Never silently choose the first candidate. Catalog addressability is not semantic proof: compare the source and question meaning, not IDs, role labels, record times or matching date text. Keep task-input evidence distinct from a claim that it currently holds. An interpreted time must quote support of the selected temporal operand, not a date of another event. If a selected association has no selected temporal operand, report time unavailable. Do not invent refs or canonical IDs. The host resolves references only and independently executes the selected branch; your descriptive task correspondence is not executable relevance.
For each supplied source, identify one literal utterance and explain its reported role. Separate a reported event from a request, recommendation, standing statement, prospective statement or uncertainty. A request, intention or recommendation is not a report that an event occurred.
Possible correspondence means the utterance could inform a specific question component, not that it answers the question. Set task_role to requested_event only for a report of an occurrence that could be the asked event; that possibility does not establish event identity. Use task_input for a report that could supply a named input to the task. A report about the same subject and requested input can be a possible task_input even when its applicability at question time is unknown. Describe it as a source report, without asserting that it persisted or applies later. Topical overlap, an unrelated completed event, a shared merchant, or timestamp proximity is not enough. Unsupported means the utterance does not address a question component; unresolved means its task correspondence cannot be determined. Unknown applicability alone is not non-correspondence or unresolved correspondence. For unsupported or unresolved, set task_role and task_component to null. None proves truth, occurrence, event identity or applicability.
Quote an exact unique contiguous excerpt from the question and from that source, including for unsupported or unresolved rows. Do not normalize, paraphrase or calculate byte offsets. The source observation clock dates the record, not the described event. Interpret a source's explicit temporal expression only against that source's own clock, never the question clock. For an interpreted time, the expression must occur exactly once inside the source excerpt; use inclusive UTC calendar dates YYYY-MM-DD in time_start and time_end, and set time_anchor to source_observation_clock for relative expressions or explicit_date for a stated calendar date. If there is no expression or the interval or anchor is uncertain, use unavailable and set all four time fields to null. Matching relative words or intervals do not establish event identity or persistence. Describe only what the text supports, and leave uncertainty unresolved.
Use one observation per supplied source when possible, including unsupported or unresolved correspondence. If a source cannot be described with a bound excerpt, omit its row. Return only the observations in JSON matching the supplied schema; the host determines coverage, not the model.`;

export function sourceTaskObservationResponseJsonSchema(): object {
  return z.toJSONSchema(SourceTaskObservationDraftSchema, { io: "output", reused: "inline",
    override: ({ jsonSchema }) => {
      if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; }
    } });
}

/** Captures model-visible input only after identity and clock preflight; this does not call a provider. */
export function buildSourceTaskObservationRequest(raw: unknown) {
  const input = SourceTaskObservationFormationInputSchema.parse(raw);
  validateInput(input);
  const catalogs = buildObservationEndpointCatalogs(input, SOURCE_TASK_OBSERVATION_FORMATION_ID);
  const visible = { question: input.query, question_observation_time: input.interpretation_clock,
    query_semantics: input.query_semantics, semantic_correspondences: input.semantic_correspondences,
    sources: input.sources.map((source, index) => ({ source_ref: source.source_ref,
      source_observation_time: source.source_observed_at, body: source.body,
      selected_interpretation: source.selected_interpretation, endpoint_catalog: catalogs[index] })) };
  return { formationIdentity: SOURCE_TASK_OBSERVATION_FORMATION_ID,
    systemPrompt: SOURCE_TASK_OBSERVATION_SYSTEM_PROMPT, userPrompt: JSON.stringify(visible),
    responseJsonSchema: sourceTaskObservationResponseJsonSchema() };
}

function validateInput(input: SourceTaskObservationFormationInput): void {
  if (compareUtcInstants(input.question_time.interpretation_clock, input.interpretation_clock) !== 0) {
    throw new Error("question_time_clock_mismatch");
  }
  const refs = new Set<string>(), identities = new Set<string>();
  for (const source of input.sources) {
    const identity = canonicalJson(source.target);
    if (refs.has(source.source_ref) || identities.has(identity)) throw new Error("duplicate_source_input");
    refs.add(source.source_ref); identities.add(identity);
    if (`sha256:${createHash("sha256").update(source.body, "utf8").digest("hex")}` !== source.target.content_digest) {
      throw new Error("source_digest_mismatch");
    }
  }
}

/** Provider transport classifies finish/failure and owns raw history; this only binds decoded drafts. */
export function interpretSourceTaskObservationSourceLocalDecoded(rawInput: unknown,
  decoded: Readonly<{ rawJson: string; finishReason: string | null }>, requestProfile: string) {
  const input = SourceTaskObservationFormationInputSchema.parse(rawInput);
  validateInput(input);
  if (!isCompleteSemanticFinish(requestProfile, decoded.finishReason)) return {
    classified: "incomplete" as const, admitted: false, outcome: { status: "incomplete" as const, reason: "noncomplete" } };
  let value: unknown;
  try { value = JSON.parse(decoded.rawJson); }
  catch { return invalid("malformed_json"); }
  const draftSchema = SourceTaskObservationDraftSchema.unwrap();
  const envelope = draftSchema.extend({ observations: z.array(z.unknown()).max(16) }).safeParse(value);
  if (!envelope.success) return invalid("invalid_shape");
  const draft = envelope.data;
  const rowSchema = draftSchema.shape.observations.unwrap().element;
  const refs = new Set<string>(), observations: SourceTaskObservation[] = [];
  const catalogs = buildObservationEndpointCatalogs(input, SOURCE_TASK_OBSERVATION_FORMATION_ID);
  const endpoint_selections: NonNullable<ReturnType<typeof resolveObservationEndpointSelection>["selection"]>[] = [];
  const diagnostics: { reason: string; source_ref?: string; row_index?: number }[] = [];
  const rowRefs = draft.observations.map(row => {
    if (typeof row !== "object" || row === null || !("source_ref" in row) || typeof row.source_ref !== "string") return undefined;
    return row.source_ref;
  });
  for (const [rowIndex, rawRow] of draft.observations.entries()) {
    const ref = rowRefs[rowIndex];
    const fail = (reason: string) => diagnostics.push({ reason, ...(ref === undefined ? {} : { source_ref: ref }), row_index: rowIndex });
    const source = input.sources.find(item => item.source_ref === ref);
    if (source === undefined) { fail(ref === undefined ? "invalid_shape" : "unknown_source_ref"); continue; }
    refs.add(source.source_ref);
    if (rowRefs.indexOf(ref) !== rowRefs.lastIndexOf(ref)) { fail("duplicate_source_ref"); continue; }
    const parsed = rowSchema.safeParse(rawRow);
    if (!parsed.success) { fail("invalid_shape"); continue; }
    const row = parsed.data;
    const resolved = resolveObservationEndpointSelection(catalogs.find(item => item.source_ref === source.source_ref)!, row);
    if (resolved.error !== undefined) { fail(resolved.error); continue; }
    const sourceExcerpt = uniqueLiteralSpan(source.body, row.source_excerpt);
    const queryExcerpt = uniqueLiteralSpan(input.query, row.query_excerpt);
    if (sourceExcerpt === undefined || queryExcerpt === undefined) { fail("quote_missing_or_ambiguous"); continue; }
    const task = row.task_correspondence === "possible"
      ? row.task_role === null || row.task_component === null || row.task_component.length === 0 ? undefined
        : { status: "possible" as const, role: row.task_role, component: row.task_component }
      : row.task_role !== null || row.task_component !== null ? undefined : { status: row.task_correspondence };
    const time = row.time_status === "unavailable"
      ? row.time_expression !== null || row.time_anchor !== null || row.time_start !== null || row.time_end !== null ? undefined
        : { status: "unavailable" as const }
      : row.time_expression === null || row.time_anchor === null || row.time_start === null || row.time_end === null ? undefined
        : { status: "interpreted" as const, expression: row.time_expression, anchor: row.time_anchor,
          interval: { start: row.time_start, end: row.time_end } };
    if (task === undefined || time === undefined) { fail("incoherent_observation"); continue; }
    const observation = { source: source.target, source_observed_at: source.source_observed_at,
      ...(resolved.association === undefined ? {} : { association: resolved.association }),
      source_excerpt: sourceExcerpt, query_excerpt: queryExcerpt,
      utterance: { kind: row.utterance_kind, description: row.description }, task_correspondence: task, event_time: time };
    const checked = SourceTaskObservationProposalSchema.safeParse({ status: "ready",
      interpretation_clock: input.interpretation_clock, observations: [observation] });
    if (!checked.success || !("observations" in checked.data)) { fail("invalid_bound_observation"); continue; }
    observations.push(checked.data.observations[0]!);
    endpoint_selections.push(resolved.selection);
  }
  for (const source of input.sources) {
    if (!refs.has(source.source_ref)) diagnostics.push({ reason: "missing_source_ref", source_ref: source.source_ref });
  }
  if (observations.length === 0) return { classified: "incomplete" as const, admitted: false,
    outcome: { status: "incomplete" as const, reason: "no_admissible_observations", diagnostics } };
  // Coverage describes admitted independent rows, never their fallible task correspondence.
  const status = diagnostics.length > 0 ? "partial" as const : "ready" as const;
  const proposal = { schema_version: 1 as const, producer_id: SOURCE_TASK_OBSERVATION_PRODUCER_ID,
    original_query_digest: `sha256:${createHash("sha256").update(input.query, "utf8").digest("hex")}`,
    question_time: input.question_time, source_task_observation: { status,
      ...(input.query_semantics === undefined ? {} : { query_semantics: input.query_semantics }),
      ...(input.semantic_correspondences === undefined ? {} : { semantic_correspondences: input.semantic_correspondences }),
      interpretation_clock: input.interpretation_clock, observations } };
  // Partial coverage can supply independent observations, but must stop a no-retry window.
  return { classified: status === "partial" ? "incomplete" as const : "interpreted" as const, admitted: true,
    outcome: { status: "source_task_observation" as const, proposal, diagnostics, endpoint_selections } };
}

function uniqueLiteralSpan(text: string, quote: string) {
  const start = text.indexOf(quote);
  if (start < 0 || text.indexOf(quote, start + 1) >= 0) return;
  const start_byte = Buffer.byteLength(text.slice(0, start), "utf8");
  return { start_byte, end_byte: start_byte + Buffer.byteLength(quote, "utf8"), text: quote };
}
function invalid(reason: string) {
  return { classified: "terminal" as const, admitted: false, outcome: { status: "invalid" as const, reason } };
}
