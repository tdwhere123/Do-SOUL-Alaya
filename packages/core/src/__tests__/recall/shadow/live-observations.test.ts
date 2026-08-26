import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  installCoreConfigFromProcessEnv,
  resetCoreConfigForTests
} from "../../../config/install-core-config.js";
import { compileRecallQueryProbes } from "../../../recall/query/recall-query-probes.js";
import { buildDefaultPolicy } from "../../../recall/runtime/orchestration.js";
import type {
  CoarseRecallCandidate,
  KeywordLexicalMergeCapture,
  KeywordSearchLaneReceipt,
  RecallSupplementaryData
} from "../../../recall/runtime/recall-service-types.js";
import {
  buildLiveObservationField,
  liveLexicalMapping,
  type LiveObservationSource
} from "../../../recall/shadow/observe/live-observations.js";
import { captureShadowIntegration, isFailClosedShadowTrace } from
  "../../../recall/shadow/integrate.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";

const NOW = "2026-07-12T00:00:00.000Z";

afterEach(() => resetCoreConfigForTests());

describe("live shadow observations", () => {
  it("does not let lane receipts independently choose the lexical observation", () => {
    const field = buildLiveObservationField(liveInput({
      query: "operator workspace",
      lanes: [
        lane("trigram", "cand-a", 0.8, 4),
        lane("porter", "cand-a", 0.8, 4),
        lane("exact", "cand-a", 0.7, 2)
      ]
    }));
    const lexical = field[keyOf("cand-a")]?.lineages.lexical;
    expect(lexical?.envelope).toEqual({
      state: "not_observed",
      reason: "missing_rank"
    });
  });

  it("uses chosen_lane including object_key_porter", () => {
    const capture: KeywordLexicalMergeCapture = {
      query_run_id: "memory.keyword.depth:3",
      merge_limit: 3,
      lanes: [{
        lane_id: "object_key_porter",
        raw_key_kind: "bm25_raw_rank",
        list_n: 1,
        status: "complete"
      }],
      candidates: [{
        candidate_key: "cand-a",
        chosen_lane_id: "object_key_porter",
        chosen_normalized_rank: 1,
        admitted: true
      }]
    };
    const field = buildLiveObservationField(liveInput({
      query: "operator workspace",
      lanes: [lane("porter", "cand-a", 0.4, 2)],
      captures: [capture]
    }));
    const lexical = field[keyOf("cand-a")]?.lineages.lexical;
    expect(lexical && "domain" in lexical ? lexical.domain : null).toMatchObject({
      lane_id: "object_key_porter",
      list_n: 1,
      raw_key_kind: "bm25_raw_rank"
    });
    expect(liveLexicalMapping(field, [capture])).toBe("raw_rank_capture");
  });

  it("does not fall back to lane receipts when raw-rank capture omitted a candidate", () => {
    const capture: KeywordLexicalMergeCapture = {
      query_run_id: "memory.keyword.depth:3",
      merge_limit: 3,
      lanes: [{
        lane_id: "porter",
        raw_key_kind: "bm25_raw_rank",
        list_n: 1,
        status: "complete"
      }],
      candidates: [{
        candidate_key: "cand-a",
        chosen_lane_id: "porter",
        chosen_normalized_rank: 1,
        admitted: true
      }]
    };
    const field = buildLiveObservationField(liveInput({
      query: "operator workspace",
      ids: ["cand-a", "cand-b"],
      lanes: [lane("porter", "cand-b", 0.8, 2)],
      captures: [capture]
    }));
    expect(field[keyOf("cand-b")]?.lineages.lexical?.envelope).toEqual({
      state: "not_observed",
      reason: "missing_rank"
    });
    expect(liveLexicalMapping(field, [capture])).toBe("raw_rank_capture");
  });

  it("projects the score-snapshot EmbDomain when the seam provides it", () => {
    const domain = Object.freeze({
      provider_kind: "local_onnx",
      model_id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      dimensions: 384,
      schema_version: 1
    });
    const field = buildLiveObservationField(liveInput({
      query: "operator workspace",
      embedding_enabled: true,
      embeddingSimilarityScores: { "cand-a": 0.5 },
      embeddingObservationDomain: domain,
      embeddingContentHashByObjectId: { "cand-a": "abc123" }
    }));
    const embedding = field[keyOf("cand-a")]?.lineages.embedding;
    expect(embedding && "snapshot" in embedding ? embedding.snapshot : null).toMatchObject({
      status: "observed",
      value: 0.5,
      domain,
      content_hash: "abc123"
    });
  });

  it("does not reconstruct lexical O from collapsed ftsRanks", () => {
    const field = buildLiveObservationField(liveInput({
      query: "operator workspace",
      ftsRanks: { "cand-a": 0.99 },
      lanes: []
    }));
    expect(field[keyOf("cand-a")]?.lineages.lexical?.envelope).toEqual({
      state: "not_observed",
      reason: "missing_rank"
    });
    expect(liveLexicalMapping(field)).toBe("not_observed");
  });

  it("observes embedding zero and treats a missing key as not_observed", () => {
    const domain = Object.freeze({
      provider_kind: "local_onnx",
      model_id: "model",
      dimensions: 384,
      schema_version: 1
    });
    const field = buildLiveObservationField(liveInput({
      query: "operator workspace",
      embedding_enabled: true,
      embeddingSimilarityScores: { "cand-a": 0 },
      embeddingObservationDomain: domain,
      embeddingContentHashByObjectId: { "cand-a": "hash-a" },
      ids: ["cand-a", "cand-b"]
    }));
    expect(field[keyOf("cand-a")]?.lineages.embedding?.envelope).toEqual({
      state: "observed",
      value: 0
    });
    expect(field[keyOf("cand-b")]?.lineages.embedding?.envelope).toEqual({
      state: "not_observed",
      reason: "missing_vector"
    });
  });

  it("fails closed when an embedding score lacks its authoritative domain or hash", () => {
    const missing = buildLiveObservationField(liveInput({
      query: "operator workspace",
      embedding_enabled: true,
      embeddingSimilarityScores: { "cand-a": 0.5 }
    }));
    expect(missing[keyOf("cand-a")]?.lineages.embedding?.envelope).toEqual({
      state: "not_observed",
      reason: "missing_authority"
    });
  });

  it("observes all applicable subject components including grounded zero", () => {
    const field = buildLiveObservationField(liveInput({
      query: "what do I prefer?",
      entryOverrides: { preference_object: "tea" }
    }));
    const subject = field[keyOf("cand-a")]?.lineages.subject_preference;
    expect(subject?.envelope.state).toBe("observed");
    expect(subject && "components" in subject ? subject.components : []).toEqual([
      {
        component_id: "preference",
        operator_id: "scorePreferenceProfileAlignment",
        authority_state: "evaluated",
        envelope: { state: "observed", value: 0 }
      },
      {
        component_id: "self_reference",
        operator_id: "scoreSelfReferenceAlignment",
        authority_state: "evaluated",
        envelope: { state: "observed", value: 0.55 }
      }
    ]);
  });

  it("aggregates only when every applicable subject component was observed", () => {
    const partial = buildLiveObservationField(liveInput({
      query: "what do I prefer?"
    }));
    const subject = partial[keyOf("cand-a")]?.lineages.subject_preference;
    expect(subject?.envelope).toEqual({ state: "not_observed", reason: "not_run" });
    expect(subject && "components" in subject ? subject.components : []).toMatchObject([
      { component_id: "preference", envelope: { state: "not_observed" } },
      { component_id: "self_reference", envelope: { state: "observed" } }
    ]);
  });

  it("derives disabled and untrusted states from production authority", () => {
    installCoreConfigFromProcessEnv({ ALAYA_RECALL_PROJECTIONS: "off" });
    const disabled = buildLiveObservationField(liveInput({
      query: "what do I prefer?", entryOverrides: { preference_object: "tea" }
    }));
    expect(disabled[keyOf("cand-a")]?.lineages.subject_preference?.envelope)
      .toEqual({ state: "not_observed", reason: "not_run" });
    resetCoreConfigForTests();
    const untrusted = buildLiveObservationField(liveInput({
      query: "what do I prefer?",
      entryOverrides: { source_kind: "assistant", preference_object: "tea" }
    }));
    expect(untrusted[keyOf("cand-a")]?.lineages.subject_preference?.envelope)
      .toEqual({ state: "not_observed", reason: "not_run" });
  });

  it("models preference-only and self-reference-only applicability", () => {
    const preference = buildLiveObservationField(liveInput({
      query: "what do I prefer?",
      subjectHints: []
    }));
    const self = buildLiveObservationField(liveInput({ query: "what did I say?" }));
    expect(subjectIds(preference)).toEqual(["preference"]);
    expect(subjectIds(self)).toEqual(["self_reference"]);
  });

  it("keeps missing event_time not_observed and projects honest zero when timed", () => {
    const missing = buildLiveObservationField(liveInput({
      query: "what happened on 2026-03-19?",
      nowIso: NOW
    }));
    expect(missing[keyOf("cand-a")]?.lineages.temporal?.envelope).toEqual({
      state: "not_observed",
      reason: "missing_event_time"
    });
    const timed = buildLiveObservationField(liveInput({
      query: "what happened on 2026-03-19?",
      nowIso: NOW,
      eventTime: "2010-01-01T00:00:00.000Z"
    }));
    const envelope = timed[keyOf("cand-a")]?.lineages.temporal?.envelope;
    expect(envelope?.state).toBe("observed");
    expect(envelope && "value" in envelope ? envelope.value : null).toBe(0);
  });

  it("does not record lexical mapping from lane receipts alone", () => {
    const trace = captureShadowIntegration({
      ...liveInput({
        query: "operator workspace",
        lanes: [lane("porter", "cand-a", 0.9, 3)]
      }),
      tokenEstimator: { estimate: () => 4 }
    });
    expect(isFailClosedShadowTrace(trace)).toBe(false);
    if (isFailClosedShadowTrace(trace)) return;
    expect(trace.lexical_mapping).toBe("not_observed");
  });
});

function liveInput(options: {
  readonly query: string;
  readonly lanes?: readonly Readonly<KeywordSearchLaneReceipt>[];
  readonly captures?: readonly Readonly<KeywordLexicalMergeCapture>[];
  readonly ftsRanks?: Readonly<Record<string, number>>;
  readonly embeddingSimilarityScores?: Readonly<Record<string, number>>;
  readonly embeddingObservationDomain?: RecallSupplementaryData["embeddingObservationDomain"];
  readonly embeddingContentHashByObjectId?: Readonly<Record<string, string>>;
  readonly embedding_enabled?: boolean;
  readonly nowIso?: string;
  readonly eventTime?: string;
  readonly ids?: readonly string[];
  readonly subjectHints?: RecallSupplementaryData["queryProbes"]["subject_hints"];
  readonly entryOverrides?: Partial<MemoryEntry>;
}) {
  const ids = options.ids ?? ["cand-a"];
  const candidates = ids.map((objectId) =>
    candidateOf(objectId, options.eventTime, options.entryOverrides));
  const policy = buildDefaultPolicy({
    strategy: "build",
    taskSurfaceRef: "task-surface-1",
    now: () => NOW,
    generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
  });
  return {
    candidates,
    policy: {
      ...policy,
      coarse_filter: {
        ...policy.coarse_filter,
        semantic_supplement: {
          ...policy.coarse_filter.semantic_supplement,
          embedding_enabled: options.embedding_enabled ?? false
        }
      }
    },
    supplementaryData: {
      ...supplementaryData(
      options.query,
      options.ftsRanks,
      options.embeddingSimilarityScores,
      options.embeddingObservationDomain,
      options.embeddingContentHashByObjectId
      ),
      ...(options.subjectHints === undefined ? {} : {
        queryProbes: {
          ...compileRecallQueryProbes(options.query),
          subject_hints: options.subjectHints
        }
      })
    },
    memoryKeywordLanes: options.lanes,
    memoryLexicalCaptures: options.captures,
    nowIso: options.nowIso
  };
}

function subjectIds(field: ReturnType<typeof buildLiveObservationField>) {
  const subject = field[keyOf("cand-a")]?.lineages.subject_preference;
  return subject && "components" in subject
    ? subject.components.map((component) => component.component_id)
    : [];
}

function candidateOf(
  objectId: string,
  eventTime?: string,
  overrides: Partial<MemoryEntry> = {}
): CoarseRecallCandidate {
  return {
    entry: createMemoryEntry({
      object_id: objectId,
      content: `Operator workspace fact ${objectId}`,
      ...overrides,
      ...(eventTime === undefined ? {} : { event_time_start: eventTime })
    }),
    admissionPlanes: ["activation"],
    firstAdmissionPlane: "activation"
  };
}

function lane(
  id: "exact" | "porter" | "trigram",
  objectId: string,
  normalizedRank: number,
  depth: number
): Readonly<KeywordSearchLaneReceipt> {
  return Object.freeze({
    lane: id,
    status: "complete",
    depth,
    observations: Object.freeze([{
      object_id: objectId,
      rank: 1,
      normalized_rank: normalizedRank
    }]),
    unseen_upper_bound: 0
  });
}

function keyOf(objectId: string): string {
  return `workspace_local:memory_entry:${objectId}`;
}

function supplementaryData(
  query: string,
  ftsRanks: Readonly<Record<string, number>> = {},
  embeddingSimilarityScores: Readonly<Record<string, number>> = {},
  embeddingObservationDomain?: RecallSupplementaryData["embeddingObservationDomain"],
  embeddingContentHashByObjectId?: Readonly<Record<string, string>>
): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(query),
    ftsRanks,
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    evidenceProjectionMatchesByRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores,
    ...(embeddingObservationDomain === undefined
      ? {}
      : { embeddingObservationDomain }),
    ...(embeddingContentHashByObjectId === undefined
      ? {}
      : { embeddingContentHashByObjectId }),
    evidenceSemanticActivationsByCandidateKey: new Map(),
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}
