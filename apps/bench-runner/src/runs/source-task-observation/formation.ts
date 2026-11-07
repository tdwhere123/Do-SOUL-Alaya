import { createHash } from "node:crypto";
import { z } from "zod";
import { SOURCE_TASK_OBSERVATION_PRODUCER_ID, SourceTaskObservationDraftSchema,
  SourceTaskObservationFormationInputSchema, SourceTaskObservationProposalSchema, canonicalJson, compareUtcInstants,
  type SourceTaskObservation, type SourceTaskObservationFormationInput } from "@do-soul/alaya-protocol";
import { isCompleteSemanticFinish } from "../compile-seed/http/semantic-provider-http.js";

export const SOURCE_TASK_OBSERVATION_SYSTEM_PROMPT = `Describe source-local task evidence, not an answer or ranking.
For each supplied source, identify one literal utterance and explain its reported role. Separate a reported event from a request, recommendation, standing statement, prospective statement or uncertainty. For possible correspondence, set task_role to requested_event or task_input and describe the specific question component it might inform; topical overlap, an unrelated completed event, a shared merchant, or timestamp proximity is not enough. Unsupported means the utterance does not correspond; unresolved means it cannot be decided. For unsupported or unresolved, set task_role and task_component to null. None is a world-truth verdict.
Quote an exact unique contiguous excerpt from the question and from that source; a temporal expression must occur exactly once inside the chosen source excerpt. Do not normalize, paraphrase or calculate byte offsets. The source observation clock dates the record, not the described event. Interpret a source's explicit temporal expression only against that source's own clock, never the question clock. For an interpreted time, use inclusive UTC calendar dates YYYY-MM-DD in time_start and time_end, and set time_anchor to source_observation_clock for relative expressions or explicit_date for a stated calendar date. If the interval or anchor is uncertain, use unavailable and set all four time fields to null. Do not infer that an old standing fact remains valid later. Matching relative words or intervals do not establish event identity. Describe only what the text supports, and leave uncertainty unresolved.
Use one observation per supplied source when possible. Use partial if any source could not be described; unavailable requires no observations. A ready result must include every supplied source. Return only JSON matching the supplied schema.`;

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
  const visible = { question: input.query, question_observation_time: input.interpretation_clock,
    sources: input.sources.map(source => ({ source_ref: source.source_ref,
      source_observation_time: source.source_observed_at, body: source.body })) };
  return { systemPrompt: SOURCE_TASK_OBSERVATION_SYSTEM_PROMPT, userPrompt: JSON.stringify(visible),
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
export function interpretSourceTaskObservationDecoded(rawInput: unknown,
  decoded: Readonly<{ rawJson: string; finishReason: string | null }>, requestProfile: string) {
  const input = SourceTaskObservationFormationInputSchema.parse(rawInput);
  validateInput(input);
  if (!isCompleteSemanticFinish(requestProfile, decoded.finishReason)) return {
    classified: "incomplete" as const, admitted: false, outcome: { status: "incomplete" as const, reason: "noncomplete" } };
  let value: unknown;
  try { value = JSON.parse(decoded.rawJson); }
  catch { return invalid("malformed_json"); }
  const parsed = SourceTaskObservationDraftSchema.safeParse(value);
  if (!parsed.success) return invalid("invalid_shape");
  const draft = parsed.data;
  if (draft.status === "unavailable") return draft.observations.length === 0
    ? { classified: "abstained" as const, admitted: false, outcome: { status: "unavailable" as const } }
    : invalid("unavailable_has_observations");
  const refs = new Set<string>(), observations: SourceTaskObservation[] = [];
  for (const row of draft.observations) {
    const source = input.sources.find(item => item.source_ref === row.source_ref);
    if (source === undefined) return invalid("unknown_source_ref");
    if (refs.has(row.source_ref)) return invalid("duplicate_source_ref");
    refs.add(row.source_ref);
    const sourceExcerpt = uniqueLiteralSpan(source.body, row.source_excerpt);
    const queryExcerpt = uniqueLiteralSpan(input.query, row.query_excerpt);
    if (sourceExcerpt === undefined || queryExcerpt === undefined) return invalid("quote_missing_or_ambiguous");
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
    if (task === undefined || time === undefined) return invalid("incoherent_observation");
    const observation = { source: source.target, source_observed_at: source.source_observed_at,
      source_excerpt: sourceExcerpt, query_excerpt: queryExcerpt,
      utterance: { kind: row.utterance_kind, description: row.description }, task_correspondence: task, event_time: time };
    const checked = SourceTaskObservationProposalSchema.safeParse({ status: draft.status,
      interpretation_clock: input.interpretation_clock, observations: [observation] });
    if (!checked.success || !("observations" in checked.data)) return invalid("invalid_bound_observation");
    observations.push(checked.data.observations[0]!);
  }
  if (draft.status === "ready" && refs.size !== input.sources.length) return invalid("ready_omits_source");
  const proposal = { schema_version: 1 as const, producer_id: SOURCE_TASK_OBSERVATION_PRODUCER_ID,
    original_query_digest: `sha256:${createHash("sha256").update(input.query, "utf8").digest("hex")}`,
    question_time: input.question_time, source_task_observation: { status: draft.status,
      interpretation_clock: input.interpretation_clock, observations } };
  // A valid partial draft can supply independent observations, but must stop a no-retry window.
  return { classified: draft.status === "partial" ? "incomplete" as const : "interpreted" as const, admitted: true,
    outcome: { status: "source_task_observation" as const, proposal } };
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
