import { describe, expect, it } from "vitest";
import { StorageTier } from "@do-soul/alaya-protocol";
import {
  DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP,
  DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS,
  DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP
} from "../../../../recall/coarse-filter/coarse-candidates.js";
import {
  buildInformativeEvidenceSearchQueries
} from "../../../../recall/coarse-filter/evidence/search-query-planner.js";
import {
  ACTIVATION_ATTRIBUTION_CHANNELS,
  ACTIVATION_ATTRIBUTION_OPERATOR_ID,
  ACTIVATION_ATTRIBUTION_STATUSES,
  auditActivationAttribution,
  inspectCharNgramConsumer,
  inspectSourceProximityConsumer,
  type ActivationAttributionAuditReceipt,
  type ActivationAttributionAuditRow,
  type ActivationAttributionChannel,
  type ActivationAttributionStatus
} from "../../../../recall/field/activation-attribution/audit.js";
import { compileRecallQueryDemand } from "../../../../recall/query/recall-query-demand.js";
import { compileRecallQueryProbes } from "../../../../recall/query/recall-query-probes.js";

const T1_QUERY = "How many concerts did I attend in 2024?";
const T1_GOLD = "I attended three concerts in 2024 including Radiohead.";
const T2_QUERY = "Which music streaming service am I subscribed to?";
const T2_GOLD = "spotify family plan on my phone";
const T3_QUERY = "Did I ever mention the yoga studio on Oak Street?";
const T3_GOLD = "ran into an old classmate near the river";
const SPEAKER_QUERY = "Who said I should try the yoga studio?";

describe("activation flood attribution audit", () => {
  it("compiles char_ngrams with no retrieval consumer", () => {
    const probes = compileRecallQueryProbes("我订阅了哪家音乐流媒体");
    const demand = compileRecallQueryDemand(probes);
    const searchQueries = buildInformativeEvidenceSearchQueries(probes);

    expect(probes.char_ngrams.length).toBeGreaterThan(0);
    expect(inspectCharNgramConsumer(probes)).toEqual({
      compiled: true,
      retrieval_consumer: "none"
    });
    expect(demand.atoms.some((atom) => probes.char_ngrams.includes(atom.value))).toBe(false);
    expect(searchQueries.some((query) => probes.char_ngrams.includes(query))).toBe(false);
  });

  it("records source proximity as HOT tierMemories with live radius caps", () => {
    expect(inspectSourceProximityConsumer()).toEqual({
      substrate: StorageTier.HOT,
      radius: DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS,
      seed_cap: DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP,
      admission_cap: DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP
    });
    expect(inspectSourceProximityConsumer()).toEqual({
      substrate: "hot",
      radius: 6,
      seed_cap: 12,
      admission_cap: 120
    });
  });

  it("pins the four statuses on T1/T2/T3-shaped rows without a KPI claim", () => {
    const t1 = auditActivationAttribution(t1Row());
    const t2 = auditActivationAttribution(t2Row());
    const t3 = auditActivationAttribution(t3Row());

    expect(t1.query_shape).toBe("t1");
    expect(t2.query_shape).toBe("t2");
    expect(t3.query_shape).toBe("t3");
    expect(uniqueStatuses(t1, t2, t3)).toEqual(new Set(ACTIVATION_ATTRIBUTION_STATUSES));
    expectT1Gaps(t1);
    expectT2Gaps(t2);
    expectT3Gaps(t3);
    for (const receipt of [t1, t2, t3]) expectGapEnvelope(receipt);
  });

  it("does not treat date or speaker as attributed flood fuel", () => {
    const dated = auditActivationAttribution(t1Row());
    const spoken = auditActivationAttribution({
      query_id: "speaker-yoga",
      query_shape: "t3",
      query_text: SPEAKER_QUERY,
      gold_surface: T3_GOLD
    });

    expect(channel(dated, "date").status).toBe("missing_attribution");
    expect(channel(spoken, "speaker")).toEqual({
      channel: "speaker",
      status: "missing_attribution",
      reason: "speaker_not_flood_fuel"
    });
    expect(channel(auditActivationAttribution({
      query_id: "t2-no-date",
      query_shape: "t2",
      query_text: T2_QUERY,
      gold_surface: T2_GOLD
    }), "date")).toEqual({
      channel: "date",
      status: "not_applicable",
      reason: "no_date_language"
    });
  });

  it("classifies probe overlap, empty query, and slice pass-through", () => {
    const empty = auditActivationAttribution({
      query_id: "empty",
      query_shape: "t1",
      query_text: "   "
    });
    const overlapping = auditActivationAttribution(overlapRow());
    const noGold = auditActivationAttribution({
      query_id: "t1-no-gold",
      query_shape: "t1",
      query_text: T1_QUERY
    });

    expect(channel(empty, "query_probes")).toEqual({
      channel: "query_probes",
      status: "not_applicable",
      reason: "empty_query"
    });
    expect(channel(noGold, "query_probes")).toEqual({
      channel: "query_probes",
      status: "unavailable",
      reason: "no_gold_surface"
    });
    expect(channel(overlapping, "query_probes").reason).toBe("receipt_attribution_partial");
    expect(channel(overlapping, "slice_compatibility").reason).toBe("slice_pass_through");
    expect(channel(overlapping, "evidence_support").reason).toBe("evidence_no_support");
    expect(channel(overlapping, "source_proximity").reason).toBe("proximity_no_neighbors");
  });

  it("keeps proximity off WARM and unobserved path/evidence as unavailable", () => {
    expect(channel(auditActivationAttribution({
      query_id: "t2-warm",
      query_shape: "t2",
      query_text: T2_QUERY,
      gold_surface: T2_GOLD,
      source_proximity: { tier: StorageTier.WARM, seed_count: 3, neighbor_count: 4 }
    }), "source_proximity").reason).toBe("proximity_not_hot_substrate");
    expect(channel(auditActivationAttribution({
      query_id: "t3-no-vectors",
      query_shape: "t3",
      query_text: T3_QUERY,
      gold_surface: T3_GOLD,
      evidence: { vectors_present: false }
    }), "evidence_support").status).toBe("unavailable");
    expect(channel(auditActivationAttribution({
      query_id: "t3-path-index",
      query_shape: "t3",
      query_text: T3_QUERY,
      gold_surface: T3_GOLD,
      path: { eligible: true, availability: "unavailable" }
    }), "path_inflow").reason).toBe("path_index_unavailable");
    expect(channel(auditActivationAttribution({
      query_id: "t3-no-seeds",
      query_shape: "t3",
      query_text: T3_QUERY,
      gold_surface: T3_GOLD,
      source_proximity: { tier: StorageTier.HOT, seed_count: 0, neighbor_count: 0 }
    }), "source_proximity").reason).toBe("proximity_no_seeds");
  });
});

function expectT1Gaps(receipt: ActivationAttributionAuditReceipt): void {
  expect(channel(receipt, "date")).toEqual({
    channel: "date",
    status: "missing_attribution",
    reason: "date_not_flood_fuel"
  });
  expect(channel(receipt, "speaker")).toEqual({
    channel: "speaker",
    status: "not_applicable",
    reason: "no_speaker_language"
  });
  expect(channel(receipt, "path_inflow")).toEqual({
    channel: "path_inflow",
    status: "not_applicable",
    reason: "path_not_eligible"
  });
}

function expectT2Gaps(receipt: ActivationAttributionAuditReceipt): void {
  expect(channel(receipt, "query_probes")).toEqual({
    channel: "query_probes",
    status: "zero_match",
    reason: "no_retrieval_probe_overlap"
  });
  expect(channel(receipt, "source_proximity")).toEqual({
    channel: "source_proximity",
    status: "missing_attribution",
    reason: "neighbor_not_flood_fuel"
  });
}

function expectT3Gaps(receipt: ActivationAttributionAuditReceipt): void {
  expect(channel(receipt, "query_probes")?.status).toBe("zero_match");
  expect(channel(receipt, "slice_compatibility")).toEqual({
    channel: "slice_compatibility",
    status: "zero_match",
    reason: "slice_no_match"
  });
  expect(channel(receipt, "path_inflow")).toEqual({
    channel: "path_inflow",
    status: "unavailable",
    reason: "path_unobserved"
  });
  expect(channel(receipt, "evidence_support")).toEqual({
    channel: "evidence_support",
    status: "unavailable",
    reason: "evidence_unobserved"
  });
}

function expectGapEnvelope(receipt: ActivationAttributionAuditReceipt): void {
  expect(receipt).toMatchObject({
    schema_version: 1,
    operator_id: ACTIVATION_ATTRIBUTION_OPERATOR_ID
  });
  expect(receipt.channels.map((row) => row.channel)).toEqual(
    [...ACTIVATION_ATTRIBUTION_CHANNELS]
  );
  expect(receipt.receipt_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(receipt).not.toHaveProperty("weight");
  expect(receipt).not.toHaveProperty("promotion");
  expect(Object.keys(receipt).sort()).toEqual([
    "channels",
    "char_ngram_consumer",
    "operator_id",
    "query_id",
    "query_shape",
    "query_text",
    "receipt_digest",
    "schema_version",
    "source_proximity_consumer"
  ]);
}

function overlapRow(): ActivationAttributionAuditRow {
  return Object.freeze({
    query_id: "t1-overlap",
    query_shape: "t1",
    query_text: T1_QUERY,
    gold_surface: T1_GOLD,
    slice: "pass_through",
    evidence: Object.freeze({ vectors_present: true, support: 0 }),
    source_proximity: Object.freeze({
      tier: StorageTier.HOT,
      seed_count: 2,
      neighbor_count: 0
    })
  });
}

function t1Row(): ActivationAttributionAuditRow {
  return Object.freeze({
    query_id: "t1-enumerative-concerts",
    query_shape: "t1",
    query_text: T1_QUERY,
    gold_surface: T1_GOLD,
    path: Object.freeze({ eligible: false })
  });
}

function t2Row(): ActivationAttributionAuditRow {
  return Object.freeze({
    query_id: "t2-music-streaming-category",
    query_shape: "t2",
    query_text: T2_QUERY,
    gold_surface: T2_GOLD,
    source_proximity: Object.freeze({
      tier: StorageTier.HOT,
      seed_count: 3,
      neighbor_count: 2
    })
  });
}

function t3Row(): ActivationAttributionAuditRow {
  return Object.freeze({
    query_id: "t3-passing-mention-yoga",
    query_shape: "t3",
    query_text: T3_QUERY,
    gold_surface: T3_GOLD,
    slice: "rejected"
  });
}

function channel(
  receipt: ReturnType<typeof auditActivationAttribution>,
  name: ActivationAttributionChannel
) {
  return receipt.channels.find((row) => row.channel === name);
}

function uniqueStatuses(
  ...receipts: readonly ReturnType<typeof auditActivationAttribution>[]
): ReadonlySet<ActivationAttributionStatus> {
  return new Set(receipts.flatMap((receipt) =>
    receipt.channels.map((row) => row.status)
  ));
}
