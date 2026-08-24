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
import { digestRecallFieldIdentity } from "../../../../recall/field/field-identity.js";
import { createRecallQueryFieldAttributionReceipt } from
  "../../../../recall/field/query-attribution/query-field-attribution.js";
import {
  ACTIVATION_ATTRIBUTION_CHANNELS,
  ACTIVATION_ATTRIBUTION_OPERATOR_ID,
  ACTIVATION_ATTRIBUTION_STATUSES,
  QUERY_PROBE_RETRIEVAL_FIELDS,
  auditActivationAttribution,
  inspectCharNgramConsumer,
  inspectSourceProximityConsumer,
  verifyActivationAttributionAudit,
  type ActivationAttributionAuditReceipt,
  type ActivationAttributionAuditRow,
  type ActivationAttributionChannel,
  type ActivationAttributionFloodObservation,
  type ActivationAttributionStatus
} from "../../../../recall/field/activation-attribution/audit.js";
import { compileRecallQueryDemand } from "../../../../recall/query/recall-query-demand.js";
import { compileRecallQueryProbes } from "../../../../recall/query/recall-query-probes.js";
import {
  createMemoryEntry,
  entityQueryKey,
  supplementary
} from "../../integrated-flood-scoring.test-support.js";

const T1_QUERY = "How many concerts did I attend in 2024?";
const T1_GOLD = "I attended three concerts in 2024 including Radiohead.";
const T2_QUERY = "Which music streaming service am I subscribed to?";
const T2_GOLD = "spotify family plan on my phone";
const T3_QUERY = "Did I ever mention the yoga studio on Oak Street?";
const T3_GOLD = "ran into an old classmate near the river";
const UPDATE_QUERY = "I originally used Spotify but now I switched.";
const TARGET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SEED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("activation flood attribution audit", () => {
  it("compiles char_ngrams with no retrieval consumer", () => {
    const probes = compileRecallQueryProbes("我订阅了哪家音乐流媒体");
    expect(probes.char_ngrams.length).toBeGreaterThan(0);
    expect(QUERY_PROBE_RETRIEVAL_FIELDS).not.toContain("char_ngrams");
    expect(inspectCharNgramConsumer(probes)).toEqual({
      compiled: true,
      retrieval_consumer: "none"
    });
    expect(compileRecallQueryDemand(probes).atoms.some((atom) =>
      probes.char_ngrams.includes(atom.value)
    )).toBe(false);
    expect(buildInformativeEvidenceSearchQueries(probes).some((query) =>
      probes.char_ngrams.includes(query)
    )).toBe(false);
  });

  it("records source proximity as HOT tierMemories with live radius caps", () => {
    expect(DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS).toBe(6);
    expect(DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP).toBe(12);
    expect(DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP).toBe(120);
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

  it("does not treat date, speaker, neighbor, or update language as flood fuel", () => {
    const dated = auditActivationAttribution(t1Row());
    const spoken = auditActivationAttribution({
      query_id: "speaker-yoga",
      query_shape: "t3",
      query_text: "Who said I should try the yoga studio?",
      gold_surface: T3_GOLD
    });
    const updated = auditActivationAttribution({
      query_id: "guarded-update",
      query_shape: "t2",
      query_text: UPDATE_QUERY,
      gold_surface: T2_GOLD
    });
    expect(channel(dated, "date")).toMatchObject({
      status: "not_applicable",
      reason: "date_not_flood_fuel",
      counts_as_fuel: false
    });
    expect(channel(spoken, "speaker")).toMatchObject({
      status: "not_applicable",
      reason: "no_speaker_probe",
      counts_as_fuel: false
    });
    expect(channel(auditActivationAttribution(t2Row()), "source_proximity")).toMatchObject({
      status: "not_applicable",
      reason: "neighbor_not_flood_fuel",
      counts_as_fuel: false
    });
    expect(updated.intent).toBe("knowledge_update");
    expect(channel(updated, "guarded_update")).toMatchObject({
      status: "not_applicable",
      reason: "guarded_update_not_flood_fuel",
      counts_as_fuel: false
    });
  });

  it("reads live slice, path, and evidence axis standings", () => {
    const passThrough = auditActivationAttribution(floodRow("t1-flood-pass", T1_QUERY, T1_GOLD));
    const compatible = auditActivationAttribution(compatibleFloodRow());
    const rejected = auditActivationAttribution(rejectedFloodRow());
    const noEvidence = auditActivationAttribution(noEvidenceRow());
    expect(channel(passThrough, "slice_compatibility")).toMatchObject({
      reason: "slice_pass_through",
      flood_axis_status: "inactive:no_slice",
      counts_as_fuel: true
    });
    expect(channel(passThrough, "path_inflow")).toMatchObject({
      reason: "path_pass_through",
      flood_axis_status: "inactive:pass_through",
      counts_as_fuel: false
    });
    expect(channel(passThrough, "evidence_support")).toMatchObject({
      status: "not_applicable",
      reason: "evidence_pass_through",
      flood_axis_status: "inactive:pass_through"
    });
    expect(channel(compatible, "slice_compatibility")).toMatchObject({
      reason: "slice_attributed_fuel",
      flood_axis_status: "active",
      counts_as_fuel: true
    });
    expect(channel(compatible, "path_inflow").reason).toBe("path_attributed_fuel");
    expect(channel(compatible, "evidence_support").reason).toBe("evidence_attributed_fuel");
    expect(compatible.fuel_verified).toBe(true);
    expect(channel(rejected, "slice_compatibility")).toMatchObject({
      status: "zero_match",
      reason: "slice_no_match",
      flood_axis_status: "inactive:no_slice_match"
    });
    expect(channel(noEvidence, "evidence_support")).toMatchObject({
      status: "zero_match",
      reason: "evidence_no_support",
      flood_axis_status: "inactive:no_evidence"
    });
    expect(channel(auditActivationAttribution({
      ...floodRow("t1-capsule", T1_QUERY, T1_GOLD),
      flood: { ...liveFlood(), memorySupplementEligible: false }
    }), "path_inflow").reason).toBe("path_not_eligible");
  });

  it("keeps date and neighbors non-fuel on a live verified flood row", () => {
    const receipt = auditActivationAttribution({
      ...compatibleFloodRow(),
      query_id: "t1-live-non-fuel",
      source_proximity: Object.freeze({
        tier: StorageTier.HOT,
        seed_count: 3,
        neighbor_count: 2
      })
    });
    expect(receipt.fuel_verified).toBe(true);
    expect(channel(receipt, "slice_compatibility")?.counts_as_fuel).toBe(true);
    expect(channel(receipt, "date")).toMatchObject({
      status: "not_applicable",
      reason: "date_not_flood_fuel",
      counts_as_fuel: false
    });
    expect(channel(receipt, "source_proximity")).toMatchObject({
      status: "not_applicable",
      reason: "neighbor_not_flood_fuel",
      counts_as_fuel: false
    });
  });

  it("classifies empty query, unobserved gold, and HOT-only proximity", () => {
    expect(channel(auditActivationAttribution({
      query_id: "empty", query_shape: "t1", query_text: "   "
    }), "query_probes").reason).toBe("empty_query");
    expect(channel(auditActivationAttribution({
      query_id: "t1-no-gold", query_shape: "t1", query_text: T1_QUERY
    }), "query_probes").reason).toBe("no_gold_surface");
    expect(channel(auditActivationAttribution({
      query_id: "t1-overlap",
      query_shape: "t1",
      query_text: T1_QUERY,
      gold_surface: T1_GOLD
    }), "query_probes").reason).toBe("query_attribution_unobserved");
    expect(channel(auditActivationAttribution({
      query_id: "t2-warm",
      query_shape: "t2",
      query_text: T2_QUERY,
      gold_surface: T2_GOLD,
      source_proximity: { tier: StorageTier.WARM, seed_count: 3, neighbor_count: 4 }
    }), "source_proximity").reason).toBe("proximity_not_hot_substrate");
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
  expect(channel(receipt, "query_probes")).toMatchObject({
    status: "missing_attribution",
    reason: "receipt_attribution_partial"
  });
  expect(channel(receipt, "date")).toMatchObject({
    status: "not_applicable",
    reason: "date_not_flood_fuel",
    counts_as_fuel: false
  });
  expect(channel(receipt, "speaker").reason).toBe("no_speaker_probe");
  expect(channel(receipt, "path_inflow").reason).toBe("path_unobserved");
  expect(channel(receipt, "guarded_update").reason).toBe("no_update_language");
  verifyActivationAttributionAudit(receipt, t1Row());
}

function expectT2Gaps(receipt: ActivationAttributionAuditReceipt): void {
  expect(channel(receipt, "query_probes")).toMatchObject({
    status: "zero_match",
    reason: "no_gold_surface_overlap"
  });
  expect(channel(receipt, "source_proximity")).toMatchObject({
    status: "not_applicable",
    reason: "neighbor_not_flood_fuel",
    counts_as_fuel: false
  });
}

function expectT3Gaps(receipt: ActivationAttributionAuditReceipt): void {
  expect(channel(receipt, "query_probes")?.status).toBe("zero_match");
  expect(channel(receipt, "slice_compatibility").reason).toBe("slice_unobserved");
  expect(channel(receipt, "path_inflow").reason).toBe("path_unobserved");
  expect(channel(receipt, "evidence_support").reason).toBe("evidence_unobserved");
}

function expectGapEnvelope(receipt: ActivationAttributionAuditReceipt): void {
  expect(receipt.operator_id).toBe(ACTIVATION_ATTRIBUTION_OPERATOR_ID);
  expect(receipt.channels.map((row) => row.channel)).toEqual(
    [...ACTIVATION_ATTRIBUTION_CHANNELS]
  );
  expect(receipt.receipt_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(receipt).not.toHaveProperty("weight");
  expect(receipt).not.toHaveProperty("promotion");
}

function t1Row(): ActivationAttributionAuditRow {
  return Object.freeze({
    query_id: "t1-enumerative-concerts",
    query_shape: "t1",
    query_text: T1_QUERY,
    gold_surface: T1_GOLD,
    query_field_attribution: partialQueryAttribution(T1_QUERY)
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
    gold_surface: T3_GOLD
  });
}

function floodRow(
  queryId: string,
  queryText: string,
  gold: string
): ActivationAttributionAuditRow {
  return Object.freeze({
    query_id: queryId,
    query_shape: "t1",
    query_text: queryText,
    gold_surface: gold,
    flood: liveFlood()
  });
}

function compatibleFloodRow(): ActivationAttributionAuditRow {
  const seed = createMemoryEntry({ object_id: SEED_ID });
  const entry = createMemoryEntry({
    object_id: TARGET_ID,
    canonical_entities: ["Ada Lovelace"],
    evidence_refs: ["ev-fiber"]
  });
  return Object.freeze({
    query_id: "t1-slice-compatible",
    query_shape: "t1",
    query_text: T1_QUERY,
    gold_surface: T1_GOLD,
    flood: Object.freeze({
      entry,
      axisInputs: Object.freeze({ R_obj: 0.2, A_path: 0.5, B_evidence: 0.7 }),
      supplementaryData: supplementary({
        queryRoutingKeys: [entityQueryKey(entry.workspace_id, "Ada Lovelace")],
        pathInflowByTarget: {
          [TARGET_ID]: [{ seedObjectId: seed.object_id, weight: 1 }]
        },
        evidenceSupportVectorsByMemoryId: {
          [TARGET_ID]: [{ source_kind: "evidence_ref", source_id: "ev-fiber", support: 0.7 }]
        }
      })
    })
  });
}

function rejectedFloodRow(): ActivationAttributionAuditRow {
  const compatible = compatibleFloodRow();
  const flood = compatible.flood!;
  return Object.freeze({
    ...compatible,
    query_id: "t3-slice-rejected",
    query_shape: "t3",
    flood: Object.freeze({
      ...flood,
      entry: createMemoryEntry({
        object_id: TARGET_ID,
        canonical_entities: ["Charles Babbage"],
        evidence_refs: ["ev-fiber"]
      })
    })
  });
}

function noEvidenceRow(): ActivationAttributionAuditRow {
  const entry = createMemoryEntry({ object_id: TARGET_ID, evidence_refs: ["ev-zero"] });
  return Object.freeze({
    query_id: "t3-evidence-zero",
    query_shape: "t3",
    query_text: T3_QUERY,
    gold_surface: T3_GOLD,
    flood: Object.freeze({
      entry,
      axisInputs: Object.freeze({ R_obj: 0.2, A_path: 0, B_evidence: 0 }),
      supplementaryData: supplementary({
        evidenceSupportVectorsByMemoryId: {
          [TARGET_ID]: [{ source_kind: "evidence_ref", source_id: "ev-zero", support: 0 }]
        }
      })
    })
  });
}

function liveFlood(): ActivationAttributionFloodObservation {
  const entry = createMemoryEntry({ object_id: TARGET_ID });
  return Object.freeze({
    entry,
    axisInputs: Object.freeze({ R_obj: 0.42, A_path: 0, B_evidence: 0 }),
    supplementaryData: supplementary()
  });
}

function partialQueryAttribution(queryText: string) {
  return createRecallQueryFieldAttributionReceipt({
    producer_operator_id: "activation_attribution_audit_test_v1",
    producer_capture_digest: digestRecallFieldIdentity({
      producer: "activation_attribution_audit_test_v1"
    }),
    query_demand: compileRecallQueryDemand(compileRecallQueryProbes(queryText)),
    attributions: []
  });
}

function channel(
  receipt: ReturnType<typeof auditActivationAttribution>,
  name: ActivationAttributionChannel
) {
  const row = receipt.channels.find((entry) => entry.channel === name);
  if (row === undefined) {
    throw new Error(`missing activation attribution channel: ${name}`);
  }
  return row;
}

function uniqueStatuses(
  ...receipts: readonly ReturnType<typeof auditActivationAttribution>[]
): ReadonlySet<ActivationAttributionStatus> {
  return new Set(receipts.flatMap((receipt) =>
    receipt.channels.map((row) => row.status)
  ));
}
