import { describe, expect, it } from "vitest";
import { compileRecallAnswerShapePlan } from "../../recall/query/recall-answer-shape-plan.js";
import {
  buildRecallCandidateAnswerSupport
} from "../../recall/query/recall-candidate-answer-support.js";
import {
  projectVerifiedUserAssertionContext
} from "../../recall/query/recall-user-assertion-context.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { createCandidate } from "./fine-assessment-selection-fixtures.js";

function planFor(query: string) {
  return compileRecallAnswerShapePlan(compileRecallQueryProbes(query));
}

function verifiedSupport(
  query: string,
  content: string,
  gist: string,
  evidenceRef = "evidence-1"
) {
  const queryProbes = compileRecallQueryProbes(query);
  const context = projectVerifiedUserAssertionContext({
    evidenceRef,
    entryContent: content,
    gist
  });
  if (context === null) throw new Error("test fixture must project a User assertion");
  const candidate = createCandidate("candidate", {
    content,
    evidence_refs: [evidenceRef]
  });
  return buildRecallCandidateAnswerSupport(
    compileRecallAnswerShapePlan(queryProbes),
    candidate.entry,
    "memory_entry",
    { queryProbes, verifiedUserAssertionContext: context }
  );
}

describe("recall candidate answer support", () => {
  it("recognizes a grounded candidate-local place answer", () => {
    const candidate = createCandidate("bookshelf", {
      content: "The new bookshelf is from IKEA.",
      evidence_refs: ["evidence-bookshelf"]
    });

    expect(buildRecallCandidateAnswerSupport(
      planFor("Where did I buy my new bookshelf from?"),
      candidate.entry,
      "memory_entry"
    )).toMatchObject({
      schema_version: 1,
      shape: "place",
      status: "compatible",
      eligible: true,
      value_supported: true,
      target_supported: true,
      relation_supported: true,
      matched_target_terms: ["bookshelf"]
    });
  });

  it("keeps a duration value diagnostic-only without target and relation support", () => {
    const candidate = createCandidate("asylum-duration", {
      content: "Over a year of uncertainty was really tough.",
      evidence_refs: ["evidence-asylum"]
    });

    expect(buildRecallCandidateAnswerSupport(
      planFor("How long did I wait for the decision on my asylum application?"),
      candidate.entry,
      "memory_entry"
    )).toEqual({
      schema_version: 1,
      shape: "duration",
      status: "value_only",
      eligible: true,
      value_supported: true,
      target_supported: false,
      relation_supported: false,
      matched_target_terms: [],
      matched_relation_terms: [],
      authority: {
        schema_version: 1,
        provenance_status: "unverified",
        subject_status: "unknown",
        target_status: "missing",
        relation_status: "missing",
        event_status: "asserted",
        time_status: "not_requested",
        binding_status: "missing_or_ambiguous",
        behavior_eligible: false,
        evidence_ref: null
      }
    });
  });

  it("keeps aggregate shapes observation-only", () => {
    const candidate = createCandidate("bike-expense", {
      content: "I paid $120 for the bike and $40 for a tune-up.",
      evidence_refs: ["evidence-bike"]
    });

    expect(buildRecallCandidateAnswerSupport(
      planFor("How much total money have I spent on bike expenses?"),
      candidate.entry,
      "memory_entry"
    )).toMatchObject({
      shape: "sum",
      status: "observation_only",
      eligible: true
    });
  });

  it("rejects synthesis and entries without an evidence reference", () => {
    const content = "The new bookshelf is from IKEA.";
    const synthesis = createCandidate(
      "synthesis",
      { content, evidence_refs: ["synthesis-source"] },
      "synthesis_capsule"
    );
    const ungrounded = createCandidate("ungrounded", { content, evidence_refs: [] });
    const plan = planFor("Where did I buy my new bookshelf from?");

    expect(buildRecallCandidateAnswerSupport(
      plan,
      synthesis.entry,
      "synthesis_capsule"
    )?.status).toBe("ineligible");
    expect(buildRecallCandidateAnswerSupport(
      plan,
      ungrounded.entry,
      "memory_entry"
    )?.status).toBe("ineligible");
  });

  it("makes an exact User-grounded place answer behavior-eligible", () => {
    expect(verifiedSupport(
      "Where did I buy my new bookshelf from?",
      "The new bookshelf is from IKEA",
      "User: The new bookshelf is from IKEA, and I'm really happy with it.\nAssistant: Nice choice.",
      "evidence-bookshelf"
    )).toMatchObject({
      status: "compatible",
      authority: {
        schema_version: 1,
        provenance_status: "verified_user_assertion",
        subject_status: "bound",
        target_status: "bound",
        relation_status: "bound",
        event_status: "asserted",
        time_status: "not_requested",
        binding_status: "unique",
        behavior_eligible: true,
        evidence_ref: "evidence-bookshelf"
      }
    });
  });

  it("does not borrow an unrelated first-person cue from the previous sentence", () => {
    const support = verifiedSupport(
      "Where did I buy my new bookshelf from?",
      "The new bookshelf is from IKEA.",
      "User: I wanted more space. The new bookshelf is from IKEA."
    );

    expect(support?.authority?.behavior_eligible).toBe(false);
  });

  it.each([
    "My sister’s new bookshelf is from IKEA.",
    "My uncle’s bookshelf is from Target."
  ])("does not treat a third-party possessive as self ownership", (content) => {
    const support = verifiedSupport(
      "Where did I buy my new bookshelf from?",
      content,
      `User: ${content}`
    );

    expect(support?.authority?.behavior_eligible).toBe(false);
  });

  it("uses prior User context to bind a candidate-local duration value", () => {
    expect(verifiedSupport(
      "How long did I wait for the decision on my asylum application?",
      "Over a year of uncertainty was really tough.",
      "User: Speaking of waiting, my asylum application was finally approved. Over a year of uncertainty was really tough.\nAssistant: That sounds difficult.",
      "evidence-asylum"
    )).toMatchObject({
      status: "value_only",
      value_supported: true,
      target_supported: false,
      relation_supported: false,
      authority: {
        provenance_status: "verified_user_assertion",
        target_status: "bound",
        relation_status: "bound",
        event_status: "asserted",
        binding_status: "unique",
        behavior_eligible: true
      }
    });
  });

  it("binds a closed self-owned took-duration context from conversational discourse", () => {
    expect(verifiedSupport(
      "How long did I wait for the decision on my asylum application?",
      "Over a year of uncertainty was really tough.",
      "User: By the way, speaking of waiting, it's crazy how long it took for my asylum application to get approved. Over a year of uncertainty was really tough.",
      "evidence-asylum"
    )?.authority).toMatchObject({
      provenance_status: "verified_user_assertion",
      target_status: "bound",
      relation_status: "bound",
      event_status: "asserted",
      binding_status: "unique",
      behavior_eligible: true
    });
  });

  it.each([
    "Speaking of waiting, my lawyer said it's crazy how long it took for my asylum application to get approved.",
    "By the way, speaking of waiting, it's crazy how long it took for my uncle's asylum application to get approved.",
    "By the way, speaking of waiting, it's crazy how long it took for my asylum application to get approved, while my divorce remained pending.",
    "By the way, speaking of waiting, it's crazy how long it took for my asylum application to get approved, said my lawyer."
  ])("rejects attributed, third-party, and multi-event took-duration contexts", (prior) => {
    const content = "Over a year of uncertainty was really tough.";
    const support = verifiedSupport(
      "How long did I wait for the decision on my asylum application?",
      content,
      `User: ${prior} ${content}`
    );

    expect(support?.authority?.behavior_eligible).toBe(false);
  });

  it("does not borrow a duration value from a conflicting adjacent event", () => {
    const support = verifiedSupport(
      "How long did I wait for the decision on my asylum application?",
      "Over a year of uncertainty was really tough.",
      "User: I waited one day for my asylum decision, while my divorce took over a year. Over a year of uncertainty was really tough."
    );

    expect(support?.authority?.behavior_eligible).toBe(false);
  });

  it.each([
    "Over a year ago, I moved to Berlin.",
    "Over a year of renovating my kitchen was exhausting.",
    "Over a year of waiting for my divorce was exhausting.",
    "Over a year of uncertainty during the renovation was really tough."
  ])("does not treat an independent duration sentence as a continuation", (content) => {
    const support = verifiedSupport(
      "How long did I wait for the decision on my asylum application?",
      content,
      `User: I waited for the decision on my asylum application. ${content}`
    );

    expect(support?.authority?.behavior_eligible).toBe(false);
  });

  it.each([
    "My lawyer said I waited for the decision on my asylum application.",
    "I waited for the decision on my asylum application while the divorce case continued.",
    "I waited for the decision on my asylum application and John waited for the divorce ruling.",
    "I waited for the decision on my asylum application as John waited for the divorce ruling."
  ])("does not bind duration through an attributed or second event", (prior) => {
    const content = "Over a year of uncertainty was really tough.";
    const support = verifiedSupport(
      "How long did I wait for the decision on my asylum application?",
      content,
      `User: ${prior} ${content}`
    );

    expect(support?.authority?.behavior_eligible).toBe(false);
  });

  it("does not borrow a requested time from an unrelated sentence", () => {
    const support = verifiedSupport(
      "Where did I buy my new bookshelf from in 2024?",
      "I bought my new bookshelf from IKEA.",
      "User: I moved in 2024. I bought my new bookshelf from IKEA."
    );

    expect(support?.authority?.behavior_eligible).toBe(false);
  });

  it.each([
    [
      "Where did I participate in the local charity 5K?",
      "By the way, the local charity 5K was such a blast."
    ],
    [
      "Where did I go for yoga?",
      "I'm going to Serenity Yoga next week."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "My sister bought the new bookshelf from IKEA."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "I considered buying the new bookshelf from IKEA."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "I returned the new bookshelf to IKEA."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "I did not buy the new bookshelf from IKEA."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "The new bookshelf is from IKEA."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "I inherited my new bookshelf from IKEA."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "I bought my new bookshelf after hearing from IKEA support."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "I might buy my new bookshelf from IKEA."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "My uncle bought my bookshelf from Target."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "I heard my uncle bought my bookshelf from Target."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "My uncle said, “I bought my new bookshelf from Target.”"
    ],
    [
      "Where did I buy my new bookshelf from?",
      "My uncle said the new bookshelf is from Target, and I'm really happy with it."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "My uncle says the new bookshelf is from Target, and I'm really happy with it."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "My uncle insists the new bookshelf is from Target, and I'm really happy with it."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "I bought my new bookshelf from Target, said my uncle."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "The new bookshelf is from IKEA, and I called my uncle."
    ],
    [
      "Where did I buy my new bookshelf from?",
      "The new bookshelf is from IKEA, and I'm happy with it, but my uncle says it is from Target."
    ]
  ])("keeps false place, prospective, third-party, reversed, and negated assertions out of behavior", (
    query,
    content
  ) => {
    const support = verifiedSupport(query, content, `User: ${content}`);

    expect(support?.authority?.behavior_eligible).toBe(false);
  });

  it.each([
    "I worked on the project in January.",
    "The project was at 50% completion.",
    "The project was near completion.",
    "The project stayed inside the budget."
  ])("does not mistake temporal, percentage, or abstract prepositions for a place", (content) => {
    const candidate = createCandidate("not-a-place", {
      content,
      evidence_refs: ["evidence-1"]
    });

    expect(buildRecallCandidateAnswerSupport(
      planFor("Where did I work on the project?"),
      candidate.entry,
      "memory_entry"
    )?.value_supported).toBe(false);
  });
});
