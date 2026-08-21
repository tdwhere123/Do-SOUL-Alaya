import { describe, expect, it } from "vitest";
import { QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibility } from
  "../../../../recall/field/open-semantic-factors/compatibility.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../recall/field/open-semantic-factors/composition.js";
import { materializeOpenSemanticFactorActivation } from
  "../../../../recall/field/open-semantic-factors/activation.js";

const QUERY_TEXT = "How long is my daily commute to work?";
const LISTEN_TEXT =
  "I've been listening to audiobooks on my 45-minute daily commute to work.";
const DURATION_TEXT = "My daily commute to work takes 45 minutes each way.";
// Capability fixture only: live commute evidence does not include query "to work".

describe("duration measure source-bound relation", () => {
  it("binds a copular how-long query to listen/duration evidence without rewriting is", () => {
    const query = copularDurationQuery();
    const evidence = listenDurationEvidence();
    const receipt = materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query
    });

    expect(query.graph?.factors.some((factor) =>
      factor.surface === "is" || factor.semantic_identity === "be")).toBe(true);
    expect(receipt).toMatchObject({
      status: "compatible",
      matched_query_proposition_count: 1
    });
    expect(receipt.proposition_matches[0]?.predicate_alignment).toMatchObject({
      operator_id: "duration_measure_binding_v1"
    });
    expect(receipt.proposition_matches[0]?.argument_mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          query_reference_kind: "variable",
          evidence_semantic_identity: "45 minutes"
        })
      ])
    );

    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: { commute: evidence }
    });
    const composition = materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    });
    expect(composition).toMatchObject({
      status: "composed",
      solution_count: 1
    });
    expect(composition.solutions[0]?.result_bindings[0]).toMatchObject({
      variable_id: "answer",
      semantic_identity: "45 minutes",
      evidence_ids: ["commute"]
    });
    expect(materializeOpenSemanticFactorActivation({
      composition, trace, query_capture: query
    }).status).toBe("composed");
  });

  it("also binds a duration-predicate evidence graph through the same operator", () => {
    const receipt = materializeOpenSemanticFactorCompatibility({
      evidence_capture: durationPredicateEvidence(),
      query_capture: copularDurationQuery()
    });
    expect(receipt).toMatchObject({
      status: "compatible",
      matched_query_proposition_count: 1
    });
    expect(receipt.proposition_matches[0]?.predicate_alignment.operator_id)
      .toBe("duration_measure_binding_v1");
  });

  it("rejects listen evidence that has no duration value", () => {
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: listenWithoutDuration(),
      query_capture: copularDurationQuery()
    })).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0,
      proposition_match_candidates: []
    });
  });

  it("rejects duration evidence whose remaining arguments miss the query subject", () => {
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: disjointListenDuration(),
      query_capture: copularDurationQuery()
    })).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it("does not treat a non-duration copula as a duration-measure binding", () => {
    const query = formation("query", "How tall is my brother?", {
      schema_version: 2,
      source_kind: "query",
      factors: [
        factor("predicate", "is", "be"),
        factor("subject", "my brother", "my brother")
      ],
      variables: [{ variable_id: "answer", surface: "How tall" }],
      result_variable_ids: ["answer"],
      propositions: [{
        proposition_id: "height-query",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "subject", "factor", "subject"),
          argument(1, "value", "variable", "answer")
        ]
      }]
    }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: listenDurationEvidence(),
      query_capture: query
    })).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it("keeps rejected and unavailable evidence on the incomparable seals", () => {
    const query = copularDurationQuery();
    const rejected = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: LISTEN_TEXT,
      proposal: { schema_version: 1, producer_operator_id: "x", source_text: "other" }
    });
    const unavailable = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: LISTEN_TEXT
    });
    expect(rejected.status).toBe("rejected");
    expect(unavailable.status).toBe("unavailable");
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: rejected, query_capture: query
    }).status).toBe("rejected");
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: unavailable, query_capture: query
    }).status).toBe("unavailable");
  });

  it("does not treat a generic speaker as a source-bound subject", () => {
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: speakerOnlyDuration(),
      query_capture: copularDurationQuery()
    })).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it("does not treat a CJK speaker as a source-bound subject", () => {
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: cjkSpeakerOnlyDuration(),
      query_capture: cjkSpeakerDurationQuery()
    })).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it("does not let a work meeting cover the commute subject", () => {
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: workMeetingDuration(),
      query_capture: copularDurationQuery()
    })).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it("does not let a daily distractor cover the commute subject", () => {
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: dailyWalkDuration(),
      query_capture: copularDurationQuery()
    })).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it("does not bind a duration-shaped object that is not a duration relation", () => {
    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: scheduledDurationShapedObject(),
      query_capture: copularDurationQuery()
    })).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });
});

function copularDurationQuery() {
  return formation("query", QUERY_TEXT, {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("predicate", "is", "be"),
      factor("subject", "my daily commute to work", "my daily commute to work")
    ],
    variables: [{ variable_id: "answer", surface: "How long" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "commute-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "duration", "variable", "answer")
      ]
    }]
  }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
}

function listenDurationEvidence() {
  return formation("evidence", LISTEN_TEXT, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("actor", "I", "i"),
      factor("predicate", "listening", "listen"),
      factor("object", "audiobooks", "audiobooks"),
      factor("duration", "45-minute", "45 minutes"),
      factor("commute", "daily commute to work", "daily commute to work")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "listen-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "agent", "factor", "actor"),
        argument(1, "object", "factor", "object"),
        argument(2, "duration", "factor", "duration"),
        argument(3, "setting", "factor", "commute")
      ]
    }]
  });
}

function durationPredicateEvidence() {
  return formation("evidence", DURATION_TEXT, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("predicate", "takes", "duration"),
      factor("subject", "daily commute to work", "daily commute to work"),
      factor("value", "45 minutes", "45 minutes")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "duration-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "duration", "factor", "value")
      ]
    }]
  });
}

function listenWithoutDuration() {
  return formation("evidence",
    "I've been listening to audiobooks on my daily commute to work.", {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("actor", "I", "i"),
      factor("predicate", "listening", "listen"),
      factor("object", "audiobooks", "audiobooks"),
      factor("commute", "daily commute to work", "daily commute to work")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "listen-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "agent", "factor", "actor"),
        argument(1, "object", "factor", "object"),
        argument(2, "setting", "factor", "commute")
      ]
    }]
  });
}

function disjointListenDuration() {
  return formation("evidence", "I listen to a 45-minute podcast about baking.", {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("actor", "I", "i"),
      factor("predicate", "listen", "listen"),
      factor("object", "podcast", "podcast"),
      factor("duration", "45-minute", "45 minutes")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "listen-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "agent", "factor", "actor"),
        argument(1, "object", "factor", "object"),
        argument(2, "duration", "factor", "duration")
      ]
    }]
  });
}

function speakerOnlyDuration() {
  return eventEvidence("I commute for 45 minutes.", [
    factor("actor", "I", "i"),
    factor("predicate", "commute", "commute"),
    factor("duration", "45 minutes", "45 minutes")
  ], [
    argument(0, "agent", "factor", "actor"),
    argument(1, "duration", "factor", "duration")
  ]);
}

function cjkSpeakerDurationQuery() {
  return formation("query", "我要多久？", {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("predicate", "要", "be"),
      factor("subject", "我", "我")
    ],
    variables: [{ variable_id: "answer", surface: "多久" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "speaker-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "duration", "variable", "answer")
      ]
    }]
  }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
}

function cjkSpeakerOnlyDuration() {
  return eventEvidence("我通勤 45 minutes。", [
    factor("actor", "我", "我"),
    factor("predicate", "通勤", "commute"),
    factor("duration", "45 minutes", "45 minutes")
  ], [
    argument(0, "agent", "factor", "actor"),
    argument(1, "duration", "factor", "duration")
  ]);
}

function workMeetingDuration() {
  return eventEvidence("I sat through a 45-minute work meeting.", [
    factor("predicate", "sat", "sit"),
    factor("subject", "work meeting", "work meeting"),
    factor("duration", "45-minute", "45 minutes")
  ], [
    argument(0, "subject", "factor", "subject"),
    argument(1, "duration", "factor", "duration")
  ]);
}

function dailyWalkDuration() {
  return eventEvidence("I walk daily for 45 minutes.", [
    factor("predicate", "walk", "walk"),
    factor("setting", "daily", "daily"),
    factor("duration", "45 minutes", "45 minutes")
  ], [
    argument(0, "setting", "factor", "setting"),
    argument(1, "duration", "factor", "duration")
  ]);
}

function scheduledDurationShapedObject() {
  return eventEvidence(
    "I scheduled a 45-minute briefing about my daily commute to work.",
    [
      factor("predicate", "scheduled", "schedule"),
      factor("object", "45-minute", "45 minutes"),
      factor("theme", "daily commute to work", "daily commute to work")
    ],
    [
      argument(0, "object", "factor", "object"),
      argument(1, "theme", "factor", "theme")
    ]
  );
}

function eventEvidence(
  sourceText: string,
  factors: readonly ReturnType<typeof factor>[],
  args: readonly ReturnType<typeof argument>[]
) {
  return formation("evidence", sourceText, {
    schema_version: 2,
    source_kind: "evidence",
    factors,
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "event",
      predicate_factor_id: "predicate",
      arguments: [...args]
    }]
  });
}

function formation(
  sourceKind: "evidence" | "query",
  sourceText: string,
  graph: unknown,
  producerOperatorId = "open-factor-test-producer-v1"
) {
  return materializeOpenSemanticFactorFormation({
    source_kind: sourceKind,
    source_text: sourceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: producerOperatorId,
      source_text: sourceText,
      graph
    }
  });
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
}

function argument(
  position: number,
  bindingIdentity: string,
  referenceKind: "factor" | "variable",
  referenceId: string
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}
