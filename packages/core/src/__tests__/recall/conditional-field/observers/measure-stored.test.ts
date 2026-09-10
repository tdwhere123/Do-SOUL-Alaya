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
const CONTENT = digestOriginalQuery("retained source");
const MEMORY_REVISION = "memory-rev-1";
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
      pair: readyPair(object, query),
      sourceRevision: MEMORY_REVISION
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
    expect(raw.referent.kind).toBe("memory_entry");
    if (raw.referent.kind !== "memory_entry") throw new Error("expected memory referent");
    expect(raw.referent.source_revision).toBe(MEMORY_REVISION);
    expect(raw.referent.source_revision).not.toBe(CONTENT);
    expect(raw.source_revision).toBe(CONTENT);
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

  it("does not use the embedding content_hash as the memory product revision", () => {
    const object = vector(OBJECT_ID, new Float32Array([1, 0]));
    const query = vector("query", new Float32Array([1, 0]));
    const raw = RawMeasurementSchema.parse(rawMeasurementFromPair({
      workspaceId: "ws",
      objectId: OBJECT_ID,
      queryDigest: DIGEST,
      pair: readyPair(object, query),
      sourceRevision: MEMORY_REVISION
    }));
    expect(raw.status).toBe("measured");
    if (raw.status !== "measured") throw new Error("expected measured raw");
    expect(MEMORY_REVISION).not.toBe(CONTENT);
    expect(raw.referent).toEqual({
      kind: "memory_entry",
      workspace_id: "ws",
      object_id: OBJECT_ID,
      source_revision: MEMORY_REVISION
    });
    expect(raw.source_revision).toBe(CONTENT);
  });

  it("keeps a ready pair unavailable when the memory product revision is missing", () => {
    const raw = RawMeasurementSchema.parse(rawMeasurementFromPair({
      workspaceId: "ws",
      objectId: OBJECT_ID,
      queryDigest: DIGEST,
      pair: readyPair(vector(OBJECT_ID, new Float32Array([1, 0])), vector("query", new Float32Array([1, 0])))
    }));
    expect(raw.status).toBe("unavailable");
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
      measureStoredPair: () => readyPair(object, query),
      source: memorySourceReader()
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
    expect(effects[0].raw_measurement.referent.kind).toBe("memory_entry");
    if (effects[0].raw_measurement.referent.kind !== "memory_entry") return;
    expect(effects[0].raw_measurement.referent.source_revision).toBe(MEMORY_REVISION);
    expect(effects[0].raw_measurement.referent.source_revision).not.toBe(CONTENT);
    expect(effects[0].raw_measurement.source_revision).toBe(CONTENT);
    expect(result.page.observations[0]?.source_revision).toBe(MEMORY_REVISION);
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

  it("does not report a native source visit when the current source came from the request cache", () => {
    const source = memorySourceReader();
    const result = observeConditionalField(measureInput({
      embeddingIds: () => ({ objectIds: [OBJECT_ID], rowVisits: 1, metadataUtf8Bytes: 8,
        truncated: false, committedThrough: OBJECT_ID }),
      measureStoredPair: () => readyPair(vector(OBJECT_ID, new Float32Array([1, 0])), vector("query", new Float32Array([1, 0]))),
      source: (input) => ({ ...source(input), rowsRead: 0, bytesRead: 0 })
    }));
    expect(result.measurements?.[0]?.raw.status).toBe("measured");
    expect(result.work.native_visits).toBe(3);
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
      pair: readyPair(vector(OBJECT_ID, new Float32Array([1, 0])), vector("query", new Float32Array([1, 0]))),
      sourceRevision: MEMORY_REVISION
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
    expect([...measured.measurements]).toEqual([{
      observation_id: "binding:emb-1",
      raw,
      cap: INAPPLICABLE_CAP
    }]);
    const measuredRow = measured.measurements.at(0);
    if (measuredRow?.raw.status !== "measured") throw new Error("expected retained measured raw");
    expect(measuredRow.raw.raw).toBe(1);
    expect(measuredRow.cap.status).toBe("inapplicable");
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
    expect([...missing.measurements]).toEqual([{
      observation_id: "binding:missing-measurement",
      raw: { status: "missing" },
      cap: INAPPLICABLE_CAP
    }]);
    expect(missing.measurements.at(0)?.raw).not.toEqual(expect.objectContaining({ raw: 0 }));
  });

  it("forwards the request model pin to embeddingIds", () => {
    const calls: Array<{ readonly modelId?: string }> = [];
    observeConditionalField(measureInput({
      embeddingIds: (input) => {
        calls.push(input);
        return {
          objectIds: [],
          rowVisits: 0,
          metadataUtf8Bytes: 0,
          truncated: false,
          committedThrough: null
        };
      }
    }, { model_id: "model-b-new" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.modelId).toBe("model-b-new");
  });

  it("forwards expected_model_id when model_id is absent", () => {
    const calls: Array<{ readonly modelId?: string }> = [];
    observeConditionalField(measureInput({
      embeddingIds: (input) => {
        calls.push(input);
        return {
          objectIds: [],
          rowVisits: 0,
          metadataUtf8Bytes: 0,
          truncated: false,
          committedThrough: null
        };
      }
    }, { expected_model_id: "model-a-old" }));
    expect(calls[0]?.modelId).toBe("model-a-old");
  });

  it("does not enumerate ids when the reader reports an unavailable mixed domain", () => {
    const result = observeConditionalField(measureInput({
      embeddingIds: () => ({
        objectIds: ["min-object-a"],
        rowVisits: 2,
        metadataUtf8Bytes: 0,
        truncated: false,
        committedThrough: "min-object-a",
        domainStatus: "unavailable"
      })
    }));
    expect(result.page.observations.map((row) => row.object_id)).not.toContain("min-object-a");
    expect(result.measurements?.[0]?.raw.status).toBe("unavailable");
    expect(result.measurements?.[0]?.cap.status).toBe("inapplicable");
  });

  it("does not mint missing when enumeration is truncated empty", () => {
    const result = observeConditionalField(measureInput({
      embeddingIds: () => ({
        objectIds: [],
        rowVisits: 1,
        metadataUtf8Bytes: 0,
        truncated: true,
        committedThrough: null
      })
    }));
    expect(result.page.outcome.status).toBe("interrupted");
    expect(result.measurements).toBeUndefined();
    expect(measurementEffectsFor(result)).toEqual([]);
  });

  it("does not start pair reads when remaining work cannot pay them", () => {
    let pairCalls = 0;
    const result = observeConditionalField(measureInput({
      embeddingIds: () => ({
        objectIds: [OBJECT_ID, "emb-2"],
        rowVisits: 8,
        metadataUtf8Bytes: 0,
        truncated: false,
        committedThrough: "emb-2"
      }),
      measureStoredPair: () => {
        pairCalls += 1;
        return readyPair(vector(OBJECT_ID, new Float32Array([1, 0])), vector("query", new Float32Array([1, 0])));
      },
      source: memorySourceReader()
    }, { work_limit: 8 }));
    expect(pairCalls).toBe(0);
    expect(result.page.observations).toHaveLength(0);
    expect(result.page.outcome.status).toBe("interrupted");
    expect(result.measurements).toBeUndefined();
  });
});

function memorySourceReader(): NonNullable<ObserverReaders["source"]> {
  return ({ objectId }) => ({
    row: {
      object_id: objectId,
      sourceRevision: MEMORY_REVISION,
      content: "retained source",
      lifecycle_state: "active"
    },
    rowsRead: 1,
    bytesRead: 8,
    unavailable: false
  });
}

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

function measureInput(
  readers: ObserverReaders,
  extra: Readonly<{
    readonly model_id?: string;
    readonly expected_model_id?: string;
    readonly work_limit?: number;
  }> = {}
) {
  const { work_limit, ...pin } = extra;
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
      work_limit: work_limit ?? 16
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
    seed_query: "seed",
    ...pin
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
