import { afterAll, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { createHash } from "node:crypto";
import { buildOfficialApiSourceCorpus } from "@do-soul/alaya-soul";
import { encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import type { SoulInterpretationResponse } from "@do-soul/alaya-protocol";
import { LongMemEvalQuestionSchema } from "../../../datasets/longmemeval/ingestion/dataset.js";
import type { LongMemEvalSourceCensusRecord } from "../../../runs/snapshot/source-records/census.js";
import { QuestionPublicationSchema } from "../../../runs/longmemeval-semantic/execute.js";
import { joinLongMemEvalAnswerSpans } from "../../../runs/longmemeval-semantic/answer-spans.js";
import { measureLongMemEvalAcquisition, summarizeLongMemEvalAcquisition } from "../../../runs/longmemeval-semantic/acquisition-measurement.js";
import { measureSourceSemanticLibraryResponse } from "../../../runs/measurement/source-semantic-library-measurement.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import type { measureSemanticChain } from "../../../runs/recall-measurement/replay.js";
import { assemble, sourceOnly, workerRecall, GOLD, DIGEST, REQUEST } from "./source-semantic-library-measurement-fixture.js";

afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
const question = LongMemEvalQuestionSchema.parse({ question_id: "q", question_type: "fixture", question: "What?", answer: "never passed to runtime",
  question_date: "2023/09/13 (Wed) 00:00", haystack_session_ids: ["s"], haystack_dates: ["2023/09/12 (Tue) 00:00"],
  answer_session_ids: ["s"], haystack_sessions: [[{ role: "user", content: "café 🐈" },
    { role: "assistant", content: "東京有答案", has_answer: true }]] });
const content = "User: café 🐈\nAssistant: 東京有答案";
const record: LongMemEvalSourceCensusRecord = { population: "longmemeval_s", question_id: "q", session_id: "s",
  session_index: 0, round_index: 0, source_id: "actual-published-round", source_version: "1", content_bytes: content,
  content_digest: DIGEST, corpus_digest: createHash("sha256").update(content).digest("hex"),
  source_observed_at: "2023-09-12T00:00:00.000Z", roles: ["user", "assistant"], units: [], repeated_assertion_text: false };
const publication = QuestionPublicationSchema.parse({ workspace_id: "ws", run_id: "run", recorded_at: "clock", snapshot_path: "unused",
  db_sha256: "unused", census_count: 1, admitted_count: 1, published_count: 0,
  sources: [{ question_id: "q", session_id: "s", source_id: record.source_id, source_version: "1", content_digest: DIGEST,
    corpus_digest: record.corpus_digest, admission: "admitted", record_id: "gold" }] });
const answerGold = joinLongMemEvalAnswerSpans(question, publication, [record]);

type Native = ReturnType<typeof measureSemanticChain>["result"]["rows"][number];
function observed(start: number, end: number, emitted = Buffer.from(content).subarray(start, end).toString("utf8"), within = true, paged = false) {
  const entries = ["gold", ...(paged ? ["other1", "other2", "other3", "other4", "other5"] : [])].map(root => {
    const entry = sourceOnly(root);
    return { ...entry, target: { ...entry.target, kind: "source_evidence" as const, ...GOLD, root_id: root,
      evidence_object_id: null, span: { content_start: start, content_end: end, retained_extent: "body" as const,
        content_complete: false, original_complete: true } } };
  });
  const index = assemble(entries, []);
  const response = encodeSourceSemanticLibraryResponse(workerRecall(index));
  if (response.operation !== "recall" || response.results === undefined) throw new Error("public recall required");
  const publicResponse = { ...response, results: response.results.map(result => ({ ...result, content_preview: emitted,
    budget_state: { ...result.budget_state, within_budget: within } })) } satisfies SoulInterpretationResponse;
  const exposure = recordSourceSemanticLibraryFirstExposure(publicResponse);
  const evaluated = measureSourceSemanticLibraryResponse({ recallResult: publicResponse, firstExposurePage: exposure,
    requestBudget: REQUEST, goldSourceUnits: [GOLD] });
  expect(evaluated.measurement?.status).toBe("validated");
  const native: Native = { query_key: "q", status: "replayed", query_failure_reason: "invalid", reason: null,
    mechanism: { status: "unexercised", reason: "invalid", validated_proof_ranks: [], source_interpretation_candidates: 0,
      correspondence_opportunities: [], correspondence_outcomes: null }, preparation_trace: null, preparation_elapsed_ms: 2,
    diagnostics: { order: publicResponse.order, discovery: publicResponse.discovery, coverage: publicResponse.coverage,
      query_semantics_status: publicResponse.query_semantics_status, work: publicResponse.work,
      delivered_results: publicResponse.results.length, delivered_proofs: 0, native_elapsed_ms: 5 }, measurement: evaluated.measurement,
    source_bearing_union: evaluated.sourceBearingUnion, evaluator_usage: evaluated.evaluator_usage };
  return { native, replay: { query_key: "q", status: "replayed" as const, response: publicResponse, first_exposure: exposure } };
}
function score(value: ReturnType<typeof observed>, gold = answerGold) {
  return measureLongMemEvalAcquisition({ cohort: "answerable", sourceGold: { sourceUnits: [GOLD], complete: true },
    answerGold: gold, ...value });
}

describe("published answer-turn exposure", () => {
  it("maps the actual published round mechanically to UTF-8 bytes, not JS indices", () => {
    expect(content.indexOf("東京有答案")).toBe(25);
    expect(answerGold).toMatchObject({ complete: true, annotated_turns: 1,
      spans: [{ session_index: 0, message_index: 1, source_id: "actual-published-round", start: 28, end: 43 }] });
    expect(Buffer.from(content).subarray(28, 43).toString("utf8")).toBe("東京有答案");
    expect(score(observed(28, 43)).metrics["answer_span_exposure@5"].status).toBe("hit");
  });

  it.each([[0, 16], [28, 31], [31, 43]])("does not confuse session membership with a complete turn window %s..%s", (start, end) => {
    const result = score(observed(start, end));
    expect(result.metrics["source_bearing_any@5"].status).toBe("hit");
    expect(result.metrics["answer_span_exposure@5"].status).toBe("miss");
    expect(result.earliest_observable_loss).toMatchObject({ status: "unknown", stage: null,
      earliest_unknown_stage: "deliverable_window", observed_failed_stage: "delivery" });
  });

  it("uses emitted prefix bytes rather than the larger index span, including omission markers", () => {
    expect(score(observed(28, 43, "東京", false)).metrics["answer_span_exposure@5"].status).toBe("miss");
    expect(score(observed(28, 43, "[payload omitted]", false)).metrics["answer_span_exposure@5"].status).toBe("miss");
  });

  it("reuses producer normalization, retains nonalternating round identity and rejects unmappable gold", () => {
    const normalized = { ...question, haystack_sessions: [[{ role: "user", content: "  café\n 🐈  " },
      { role: "assistant", content: "東京有答案", has_answer: true }]] };
    expect(joinLongMemEvalAnswerSpans(normalized, publication, [record])).toEqual(answerGold);
    expect(buildOfficialApiSourceCorpus("", [{ role: "user", content: "  café\n 🐈  " }])).toBe("User: café 🐈");
    const nonalternating = { ...question, haystack_sessions: [[{ role: "user", content: "before" },
      { role: "user", content: "café 🐈" }, { role: "assistant", content: "東京有答案", has_answer: true }]] };
    expect(joinLongMemEvalAnswerSpans(nonalternating, publication, [{ ...record, round_index: 1 }]).spans[0]?.message_index).toBe(2);
    const absent = joinLongMemEvalAnswerSpans(question, publication, []);
    expect(absent).toMatchObject({ annotated_turns: 1, complete: false, spans: [] });
    expect(score(observed(0, 16), absent).metrics["answer_span_exposure@5"].status).toBe("unknown");
    const changed = joinLongMemEvalAnswerSpans(question, publication, [{ ...record, content_digest: `sha256:${"ef".repeat(32)}` }]);
    expect(changed.complete).toBe(false);
    const missingAnnotations = joinLongMemEvalAnswerSpans({ ...question,
      haystack_sessions: question.haystack_sessions.map(session => session.map(turn => ({ ...turn, has_answer: false }))) }, publication, [record]);
    expect(score(observed(28, 43), missingAnnotations).metrics["answer_span_exposure@5"].status).toBe("unknown");
  });

  it("preserves a verified exposure under an incomplete gold join but does not close unresolved negatives", () => {
    const positive = score(observed(28, 43), { ...answerGold, annotated_turns: 2, complete: false });
    expect(positive.metrics["answer_span_exposure@5"].status).toBe("hit");
    const value = observed(0, 16);
    if (value.native.source_bearing_union === null) throw new Error("native union required");
    const unresolved = { status: "unavailable" as const, value: null, reason: "unvisited native sources" };
    value.native.source_bearing_union = { ...value.native.source_bearing_union, any_at_5: unresolved, any_at_10: unresolved };
    const negative = score(value);
    expect(negative.metrics["source_bearing_any@5"].status).toBe("unknown");
    expect(negative.metrics["answer_span_exposure@5"].status).toBe("unknown");
    expect(negative.earliest_observable_loss).toMatchObject({ status: "unknown", stage: null, observed_failed_stage: null });
  });

  it("does not infer full support sufficiency from exposing every annotated turn", () => {
    expect(score(observed(28, 43)).support_sufficiency).toEqual({ status: "not_measured", reason: "no_evaluator_frozen_full_support_set" });
  });

  it("keeps @10 unknown for an unobserved continuation without backfilling @5", () => {
    const value = observed(0, 16, undefined, true, true);
    expect(value.replay.response.index?.continuation).not.toBeNull();
    const result = score(value);
    expect(result.delivery).toMatchObject({ observed_pages: 1, observed_roots: 5, continuation: "unobserved" });
    expect(result.metrics["answer_span_exposure@5"].status).toBe("miss");
    expect(result.metrics["answer_span_exposure@10"]).toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(result.metrics["source_bearing_any@10"].status).toBe("hit");
    const changed = score({ ...value, replay: { ...value.replay, response: { ...value.replay.response,
      index: { ...value.replay.response.index!, continuation: null } } } });
    expect(changed.metrics["answer_span_exposure@5"].status).toBe("unknown");
    expect(score(observed(0, 16)).metrics["answer_span_exposure@10"].status).toBe("miss");
  });

  it("keeps invalid, unknown, refusal and abstention rows in the denominator and costs unallocated", () => {
    const rows = [score(observed(28, 43)), ...["invalid", "unknown", "refusal"].map(unavailableReason =>
      measureLongMemEvalAcquisition({ cohort: "answerable", unavailableReason })),
      measureLongMemEvalAcquisition({ cohort: "abstention" })];
    const summary = summarizeLongMemEvalAcquisition(rows);
    expect(summary.metrics["answer_span_exposure@5"]).toEqual({ denominator: 5, hits: 1, misses: 0,
      unknown: 4, lower_bound: 0.2, upper_bound: 1 });
    expect(summary.observed_costs.native_elapsed_including_preparation).toEqual({ unit: "milliseconds", known: 1, unknown: 4, known_sum: 5 });
    expect(summary.cost_availability.Field).toEqual({ known: 0, unknown: 5, not_run: 0 });
    expect(rows[0]!.costs.temperature).toBe("unknown");
  });

  it("reports complete coverage beside any exposure and keeps the unobserved tail unknown", () => {
    const complete = score(observed(28, 43));
    expect(complete.metrics["answer_complete_coverage@5"]).toEqual({ status: "hit", reason: null });
    expect(complete.metrics["answer_complete_coverage@10"]).toEqual({ status: "hit", reason: null });
    const partial = score(observed(0, 16));
    expect(partial.metrics["answer_complete_coverage@5"].status).toBe("miss");
    expect(partial.metrics["answer_complete_coverage@10"].status).toBe("miss");
    const paged = score(observed(0, 16, undefined, true, true));
    expect(paged.metrics["answer_complete_coverage@5"].status).toBe("miss");
    expect(paged.metrics["answer_complete_coverage@10"])
      .toEqual({ status: "unknown", reason: "second_page_not_observed" });
    expect(paged.delivery).toMatchObject({ observed_pages: 1, observed_roots: 5, continuation: "unobserved" });
  });

  it("conserves every selection row in the complete-coverage denominator and bounds", () => {
    const rows = [score(observed(28, 43)), ...["invalid", "unknown", "refusal"].map(unavailableReason =>
      measureLongMemEvalAcquisition({ cohort: "answerable", unavailableReason })),
      measureLongMemEvalAcquisition({ cohort: "abstention" })];
    const summary = summarizeLongMemEvalAcquisition(rows);
    expect(summary.metrics["answer_complete_coverage@5"]).toEqual({ denominator: 5, hits: 1, misses: 0,
      unknown: 4, lower_bound: 0.2, upper_bound: 1 });
    expect(summary.metrics["answer_complete_coverage@10"]).toEqual({ denominator: 5, hits: 1, misses: 0,
      unknown: 4, lower_bound: 0.2, upper_bound: 1 });
  });
});
