import { afterAll, describe, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../support/strict-provider-free-boundary.js");
  const safe = installProviderFreeBoundary(), strict = installStrictProviderFreeBoundary();
  return { safe, strict };
});

import { UNKNOWN_UTTERANCE_ATTRIBUTION } from "@do-soul/alaya-protocol";
import { buildLongMemEvalQueryInput, createLongMemEvalTaskPersonaPolicy } from
  "../../../datasets/longmemeval/ingestion/task-persona.js";
import { createTestLongMemEvalDatasetAuthority } from "./test-dataset-authority.js";
import type { LoadedLongMemEvalDataset } from "../../../datasets/longmemeval/ingestion/fetch.js";

function personaDataset(sha256 = "a".repeat(64), role = "user", content = "I chose café. 雪",
  question = "What did I choose? 雪"): LoadedLongMemEvalDataset {
  const questions = ["first", "second"].map(question_id => ({ question_id, question_type: "authored fixture",
    question, answer: "unused fixture metadata", question_date: "2023/09/13 (Wed) 00:00",
    haystack_session_ids: ["actual-session-a", "actual-session-b"],
    haystack_dates: ["2023/09/11 (Mon) 00:00", "2023/09/12 (Tue) 00:00"], answer_session_ids: [],
    haystack_sessions: [[{ role, content },
      { role: "assistant", content: "User: I chose gold." }], [{ role: "user", content: "I chose tea." }]] }));
  return { questions, sha256, sourcePath: "authored fixture", checksumSource: "authored fixture",
    promotionAuthority: createTestLongMemEvalDatasetAuthority({ datasetSha256: sha256, questionInputs: questions,
      assignments: questions.map(q => ({ question_id: q.question_id, dataset_cohort: "answerable" })) }) };
}

afterAll(() => {
  isolation.strict.restore(); isolation.safe.restore();
  expect(isolation.strict.forbidden).toEqual([]); expect(isolation.safe.violations).toEqual([]);
});

function source(policy: ReturnType<typeof createLongMemEvalTaskPersonaPolicy>, overrides: Partial<Parameters<typeof policy.source>[0]> = {}) {
  return policy.source({ questionId: "first", sessionIndex: 0, messageIndex: 0,
    role: "user", content: "I chose café. 雪", ...overrides });
}

describe("question-local presented LongMemEval persona inputs", () => {
  it("keeps actual distinct session coordinates and a separate original-query occurrence with exact UTF-8 ranges", () => {
    const dataset = personaDataset(), policy = createLongMemEvalTaskPersonaPolicy(dataset);
    const first = source(policy), second = source(policy, { sessionIndex: 1, content: "I chose tea." });
    const query = buildLongMemEvalQueryInput(dataset.questions[0]!, { persona: policy });
    const issuer = `bench:longmemeval_s:${"a".repeat(64)}:first:longmemeval-question-local-persona-v1`;
    expect(first).toEqual({ contract: "utterance-attribution-v1", status: "captured", issuer_scope: issuer,
      utterances: [{ occurrence_id: "session:0:message:0", conversation_ref: "session:0:actual-session-a",
        author_ref: "task-presented-user", utf8_span: [0, 18] }] });
    expect(second).toEqual({ contract: "utterance-attribution-v1", status: "captured", issuer_scope: issuer,
      utterances: [{ occurrence_id: "session:1:message:0", conversation_ref: "session:1:actual-session-b",
        author_ref: "task-presented-user", utf8_span: [0, 12] }] });
    expect(query.attribution_context).toEqual({ contract: "utterance-attribution-v1", status: "captured", issuer_scope: issuer,
      utterances: [{ occurrence_id: "query", conversation_ref: "query", author_ref: "task-presented-user", utf8_span: [0, 22] }] });
    expect(query.original_query).toBe("What did I choose? 雪");
    expect(query.approved_fixed_context?.context_id).toBe(`bench:lme-persona-v1:${"a".repeat(64)}:first`);
    const notes = query.approved_fixed_context?.notes ?? "";
    expect(notes.length).toBeLessThanOrEqual(1024);
    for (const expected of ["longmemeval-question-local-persona-v1", "LongMemEval sections 3.1-3.2",
      "one question-local user persona", "including distinct sessions", "actual session coordinates", "query is separate",
      "equal author_ref alone does not establish cross-session identity", "not authenticated common authorship",
      "real-person identity", "statement truth", "cross-question identity", "not change outer authorship",
      "Each C correspondence still needs independent source-grounded justification"]) expect(notes).toContain(expected);
  });

  it("never gives an assistant a task-user author, even when its full body quotes User or I", () => {
    const policy = createLongMemEvalTaskPersonaPolicy(personaDataset());
    expect(source(policy, { messageIndex: 1, role: "assistant", content: "User: I chose gold." })).toMatchObject({
      status: "captured", utterances: [{ occurrence_id: "session:0:message:1", author_ref: null,
        conversation_ref: "session:0:actual-session-a", utf8_span: [0, 19] }] });
    expect(() => source(policy, { messageIndex: 1, role: "user", content: "User: I chose gold." })).toThrow(/original occurrence/);
  });

  it("separates other questions and releases rather than treating equal role or author strings as identity", () => {
    const dataset = personaDataset(), otherDataset = personaDataset("b".repeat(64));
    const policy = createLongMemEvalTaskPersonaPolicy(dataset), otherPolicy = createLongMemEvalTaskPersonaPolicy(otherDataset);
    const first = policy.query("first", dataset.questions[0]!.question);
    const second = policy.query("second", dataset.questions[1]!.question);
    const other = otherPolicy.query("first", otherDataset.questions[0]!.question);
    expect(first.attribution_context).not.toEqual(second.attribution_context);
    expect(first.attribution_context).not.toEqual(other.attribution_context);
    expect(new Set([first, second, other].map(item => item.approved_fixed_context.context_id)).size).toBe(3);
  });

  it("fails closed for unverified releases, unsupported questions/roles and changed source/query occurrences", () => {
    const dataset = personaDataset(), policy = createLongMemEvalTaskPersonaPolicy(dataset);
    expect(() => createLongMemEvalTaskPersonaPolicy({ ...dataset, promotionAuthority: null })).toThrow(/official dataset pin/);
    expect(() => createLongMemEvalTaskPersonaPolicy({ ...dataset, sha256: "b".repeat(64) })).toThrow(/official dataset pin/);
    expect(() => createLongMemEvalTaskPersonaPolicy({ ...dataset, questions: [{ ...dataset.questions[0]!, question_id: "foreign" }] })).toThrow();
    expect(() => policy.query("foreign", dataset.questions[0]!.question)).toThrow(/outside/);
    expect(() => policy.query("first", "Changed question?")).toThrow(/original question/);
    for (const patch of [{ role: "system" }, { content: "Changed body." }, { sessionIndex: 5 }, { messageIndex: -1 }]) {
      expect(() => source(policy, patch)).toThrow();
    }
    const modified = personaDataset(); modified.questions[0]!.question = "Changed question?";
    expect(() => createLongMemEvalTaskPersonaPolicy(modified)).toThrow(/verified original/);
    const unsupported = personaDataset("a".repeat(64), "system");
    expect(() => source(createLongMemEvalTaskPersonaPolicy(unsupported), { role: "system" })).toThrow(/unsupported/);
    const emptySystem = personaDataset("a".repeat(64), "system", "");
    expect(() => source(createLongMemEvalTaskPersonaPolicy(emptySystem), { role: "system", content: "" })).toThrow(/unsupported/);
    const emptyQuery = createLongMemEvalTaskPersonaPolicy(personaDataset("a".repeat(64), "user", "I chose café. 雪", ""));
    expect(() => emptyQuery.query("first", "")).toThrow(/nonempty/);
  });

  it("keeps empty original messages unknown without inventing utterance spans", () => {
    const emptyUser = createLongMemEvalTaskPersonaPolicy(personaDataset("a".repeat(64), "user", ""));
    expect(source(emptyUser, { content: "" })).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
    const emptyAssistant = createLongMemEvalTaskPersonaPolicy(personaDataset("a".repeat(64), "assistant", ""));
    expect(source(emptyAssistant, { role: "assistant", content: "" })).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
    expect(source(createLongMemEvalTaskPersonaPolicy(personaDataset())).status).toBe("captured");
    expect(() => source(emptyUser, { content: "I chose café. 雪" })).toThrow(/original occurrence/);
  });

  it("leaves default query attribution unknown and does not let caller context replace the opt-in limitations", () => {
    const dataset = personaDataset(), question = dataset.questions[0]!;
    expect(buildLongMemEvalQueryInput(question)).toEqual({ original_query: question.question,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION });
    expect(buildLongMemEvalQueryInput(question, { approvedFixedContext: { context_id: "ordinary", notes: "Unchanged." } }))
      .toEqual({ original_query: question.question, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
        approved_fixed_context: { context_id: "ordinary", notes: "Unchanged." } });
    expect(() => buildLongMemEvalQueryInput(question, { persona: createLongMemEvalTaskPersonaPolicy(dataset),
      approvedFixedContext: { context_id: "replacement" } })).toThrow(/cannot be replaced/);
  });
});
