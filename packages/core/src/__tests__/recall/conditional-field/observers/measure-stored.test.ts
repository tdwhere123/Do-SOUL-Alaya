import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  ProjectedCapSchema,
  RawMeasurementSchema,
  type QueryInterpretation
} from "@do-soul/alaya-protocol";
import {
  observeConditionalField,
  startObserverCursor,
  type ObserverReaders
} from "../../../../recall/conditional-field/observers/observe.js";
import {
  applyObserverPage,
  createConditionalField
} from "../../../../recall/conditional-field/engine/field-engine.js";
import {
  COSINE_DOMAIN_ID,
  INAPPLICABLE_CAP,
  STORED_COSINE_PRODUCER_ID,
  finiteCosine,
  queryDigestOf,
  rawMeasurementFromPair,
  type StoredEmbeddingVector,
  type StoredPairMeasurement
} from "../../../../recall/conditional-field/observers/measure-stored.js";
import { digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import { measurementEffectsFor } from "../../../../recall/runtime/measurement-effects.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { INTERPRETATION_CLOCK, SNAPSHOT_ID, defaultBudget, defaultView } from "../reference/deployment.fixture.js";

const DIGEST = digestOriginalQuery("seed");
const CONTENT = `sha256:${"a".repeat(64)}`;
const OBJECT_ID = "emb-1";

describe("stored pair measurement producer", () => {
  it("emits a finite measured raw from stored artifacts and keeps cosine off the cap", () => {
    const object = vector(OBJECT_ID, new Float32Array([1, 0]));
    const query = vector("query", new Float32Array([1, 0]));
    const cosine = finiteCosine(query.embedding, object.embedding);
    expect(cosine).toBe(1);
    const raw = RawMeasurementSchema.parse(rawMeasurementFromPair({
      workspaceId: "ws",
      objectId: OBJECT_ID,
      queryDigest: DIGEST,
      pair: readyPair(object, query)
    }));
    expect(raw.status).toBe("measured");
    if (raw.status !== "measured") throw new Error("expected measured raw");
    expect(Number.isFinite(raw.raw as number)).toBe(true);
    expect(raw.raw).toBe(1);
    expect(raw.raw).not.toBe(950);
    expect(raw.raw).not.toBe(850);
    expect(raw.producer_id).toBe(STORED_COSINE_PRODUCER_ID);
    expect(raw.domain).toBe(COSINE_DOMAIN_ID);
    expect(raw.query_digest).toBe(DIGEST);
    const cap = ProjectedCapSchema.parse(INAPPLICABLE_CAP);
    expect(cap.status).toBe("inapplicable");
    expect("milligrades" in cap).toBe(false);
    expect(cap).not.toEqual(expect.objectContaining({ milligrades: raw.raw }));
  });

  it("keeps a missing stored artifact as missing, not zero", () => {
    const raw = RawMeasurementSchema.parse(rawMeasurementFromPair({
      workspaceId: "ws",
      objectId: OBJECT_ID,
      queryDigest: DIGEST,
      pair: {
        object: null,
        query: null,
        objectStatus: "missing",
        queryStatus: "missing",
        rowVisits: 1,
        bytesRead: 0
      }
    }));
    expect(raw.status).toBe("missing");
    expect(raw).not.toEqual(expect.objectContaining({ raw: 0 }));
    expect(RawMeasurementSchema.parse({ status: "missing" }).status).toBe("missing");
  });

  it("treats an absent query embedding as unavailable, not zero", () => {
    const raw = RawMeasurementSchema.parse(rawMeasurementFromPair({
      workspaceId: "ws",
      objectId: OBJECT_ID,
      queryDigest: DIGEST,
      pair: {
        object: vector(OBJECT_ID, new Float32Array([1, 0])),
        query: null,
        objectStatus: "ready",
        queryStatus: "missing",
        rowVisits: 2,
        bytesRead: 8
      }
    }));
    expect(raw.status).toBe("unavailable");
    expect(raw).not.toEqual(expect.objectContaining({ raw: 0 }));
  });

  it("attaches measured effects on the observer path without minting milligrades from cosine", () => {
    const object = vector(OBJECT_ID, new Float32Array([0, 1]));
    const query = vector("query", new Float32Array([1, 0]));
    const result = observeConditionalField(measureInput({
      embeddingIds: () => ({
        objectIds: [OBJECT_ID],
        rowVisits: 1,
        metadataUtf8Bytes: 8,
        truncated: false,
        committedThrough: OBJECT_ID
      }),
      measureStoredPair: () => readyPair(object, query)
    }));
    expect(result.page.observations).toHaveLength(1);
    expect(result.page.observations[0]?.association_milligrades).toBeUndefined();
    expect(result.page.observations[0]?.low_milligrades).toBeUndefined();
    expect(result.page.observations[0]?.high_milligrades).toBeUndefined();
    const effects = measurementEffectsFor(result);
    expect(effects).toHaveLength(1);
    expect(effects[0]?.missing_measurement).toBeUndefined();
    expect(effects[0]?.raw_measurement?.status).toBe("measured");
    expect(effects[0]?.projected_cap).toEqual({ status: "inapplicable" });
    if (effects[0]?.raw_measurement?.status !== "measured") throw new Error("expected measured effect");
    expect(Number.isFinite(effects[0].raw_measurement.raw as number)).toBe(true);
    expect(effects[0].raw_measurement.raw).toBe(0);
    expect(effects[0].projected_cap).not.toEqual(expect.objectContaining({
      milligrades: effects[0].raw_measurement.raw
    }));
  });

  it("emits missing rather than zero when the stored object vector is absent", () => {
    const result = observeConditionalField(measureInput({
      embeddingIds: () => ({
        objectIds: [OBJECT_ID],
        rowVisits: 1,
        metadataUtf8Bytes: 8,
        truncated: false,
        committedThrough: OBJECT_ID
      }),
      measureStoredPair: () => ({
        object: null,
        query: null,
        objectStatus: "missing",
        queryStatus: "missing",
        rowVisits: 1,
        bytesRead: 0
      })
    }));
    const effects = measurementEffectsFor(result);
    expect(effects[0]?.raw_measurement?.status).toBe("missing");
    expect(effects[0]?.missing_measurement).toBe(true);
    expect(JSON.stringify(effects)).not.toContain("\"raw\":0");
  });

  it("keeps a missing query embedding residual unknown on the field", () => {
    const observed = observeField(interpretation(), {
      workspace_id: "ws",
      query_text: "seed",
      budget: defaultBudget(),
      as_of: INTERPRETATION_CLOCK,
      readers: {
        lexical: () => ({
          ids: ["seed"],
          nativeVisits: 1,
          nativeBytes: 1,
          rowsRead: 1,
          bytesRead: 1,
          truncated: false
        }),
        embeddingIds: () => ({
          objectIds: [OBJECT_ID],
          rowVisits: 1,
          metadataUtf8Bytes: 8,
          truncated: false,
          committedThrough: OBJECT_ID
        }),
        measureStoredPair: () => ({
          object: vector(OBJECT_ID, new Float32Array([1, 0])),
          query: null,
          objectStatus: "ready",
          queryStatus: "missing",
          rowVisits: 2,
          bytesRead: 8
        })
      }
    });
    expect(observed.residuals.some((region) =>
      region.kind === "binding" && region.status === "unknown"
    )).toBe(true);
    expect(observed.observations.every((observation) =>
      observation.association_milligrades === undefined
    )).toBe(true);
    expect(queryDigestOf(measureInput({}))).toBe(DIGEST);
  });

  it("applyObserverPage retains measured raw and missing-not-zero on field state", () => {
    const initial = createConditionalField({ interpretation: interpretation(), budget: defaultBudget() });
    const raw = RawMeasurementSchema.parse(rawMeasurementFromPair({
      workspaceId: "ws",
      objectId: OBJECT_ID,
      queryDigest: DIGEST,
      pair: readyPair(vector(OBJECT_ID, new Float32Array([1, 0])), vector("query", new Float32Array([1, 0])))
    }));
    const measured = applyObserverPage(initial, {
      page: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        query_id: initial.query_id,
        snapshot_id: initial.snapshot_id,
        cursor: startObserverCursor({
          cursor_id: "binding",
          snapshot_id: initial.snapshot_id,
          query_id: initial.query_id,
          region_id: "binding"
        }),
        observations: [],
        outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "exhausted" },
        open_regions: []
      },
      effects: [{
        observation_id: "binding:emb-1",
        raw_measurement: raw,
        projected_cap: INAPPLICABLE_CAP
      }]
    });
    expect(measured.measurements).toEqual([{
      observation_id: "binding:emb-1",
      raw,
      cap: INAPPLICABLE_CAP
    }]);
    if (measured.measurements[0]?.raw.status !== "measured") throw new Error("expected retained measured raw");
    expect(measured.measurements[0].raw.raw).toBe(1);
    expect(measured.measurements[0].cap.status).toBe("inapplicable");
    const missing = applyObserverPage(initial, {
      page: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        query_id: initial.query_id,
        snapshot_id: initial.snapshot_id,
        cursor: startObserverCursor({
          cursor_id: "binding",
          snapshot_id: initial.snapshot_id,
          query_id: initial.query_id,
          region_id: "binding"
        }),
        observations: [],
        outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "exhausted" },
        open_regions: []
      },
      effects: [{
        observation_id: "binding:missing-measurement",
        raw_measurement: { status: "missing" },
        projected_cap: INAPPLICABLE_CAP,
        missing_measurement: true
      }]
    });
    expect(missing.measurements).toEqual([{
      observation_id: "binding:missing-measurement",
      raw: { status: "missing" },
      cap: INAPPLICABLE_CAP
    }]);
    expect(missing.measurements[0]?.raw).not.toEqual(expect.objectContaining({ raw: 0 }));
  });
});

function vector(objectId: string, embedding: Float32Array): StoredEmbeddingVector {
  return {
    object_id: objectId,
    model_id: "stored-fixture",
    provider_kind: "openai",
    schema_version: 1,
    dimensions: embedding.length,
    content_hash: CONTENT,
    embedding
  };
}

function readyPair(object: StoredEmbeddingVector, query: StoredEmbeddingVector): StoredPairMeasurement {
  return {
    object,
    query,
    objectStatus: "ready",
    queryStatus: "ready",
    rowVisits: 2,
    bytesRead: 16
  };
}

function measureInput(readers: ObserverReaders) {
  return {
    lease: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      lease_id: "lease",
      snapshot_id: SNAPSHOT_ID,
      query_id: "admission-probe",
      status: "active" as const
    },
    action: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      action: "measurement" as const,
      region_id: "binding",
      work_limit: 16
    },
    cursor: startObserverCursor({
      cursor_id: "binding",
      snapshot_id: SNAPSHOT_ID,
      query_id: "admission-probe",
      region_id: "binding"
    }),
    query: interpretation(),
    workspace_id: "ws",
    readers,
    seed_query: "seed"
  };
}

function interpretation(): QueryInterpretation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "admission-probe",
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "relation",
      relation_kind: "observed_log",
      source_variable: "x",
      target_variable: "y",
      guard: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        kind: "query_predicate",
        verdict: "unresolved",
        variable: "y",
        time_scope: "none"
      },
      facet_mode: "same_path",
      threshold_milligrades: 0
    },
    view: defaultView(),
    holes: [],
    hypotheses: []
  };
}
