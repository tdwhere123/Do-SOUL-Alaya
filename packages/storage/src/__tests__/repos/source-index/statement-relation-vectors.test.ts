import { afterEach, expect, it } from "vitest";
import { hashContentDigest, prepareSourceIndexDocument } from "@do-soul/alaya-protocol";
import { encodeEmbeddingBlob } from "../../../repos/memory/embedding-vector-validity.js";
import { BUDGET, CLOCK, WORKSPACE, configuration, fieldSha256, fixture, publishSource, type Fixture } from "./source-index-fixture.js";
import { contextOf, publishMessages, publishStatement } from "./source-template-fixture.js";

const opened: Fixture[] = [];
afterEach(() => { for (const environment of opened.splice(0)) environment.database.close(); });

const QUERY = { work_units: 100_000, memory_bytes: 10_000_000 };
const VECTOR = new Float32Array([0.6, 0.8, 0]);

function setupStatement() {
  const environment = fixture(); opened.push(environment);
  const published = publishMessages(environment, [{ role: "user", text: "I ordered a café cocktail." }]);
  const statement = publishStatement(environment, published, "relation-overlay");
  const generation = environment.index.begin(environment.index.select(WORKSPACE, configuration()));
  environment.index.capturePage(WORKSPACE, generation.generation_id, 8, BUDGET);
  const targets = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
  const source = targets.find(row => row.auxiliary !== undefined);
  if (source === undefined) throw new Error("expected statement key target");
  for (const target of targets) {
    const read = environment.index.readDocument(WORKSPACE, generation.generation_id, target.root_key, 65_536, BUDGET);
    if (read.status !== "ready") throw new Error(read.reason);
    const document = prepareSourceIndexDocument({ source: target, body: read.body, profile: configuration().profile }, fieldSha256);
    expect(environment.index.writeDocument(WORKSPACE, generation.generation_id, document, BUDGET).status).toBe("accepted");
    for (const window of document.windows) {
      expect(environment.index.writeVector(WORKSPACE, generation.generation_id, {
        window_id: window.window_id, input_digest: window.content_digest, embedding: VECTOR, token_count: 2, truncated: false
      })).toEqual({ status: "accepted" });
    }
  }
  const digest = hashContentDigest(statement.bound.statement.relation, fieldSha256);
  return { environment, generation, source, digest, relation: statement.bound.statement.relation };
}

it("persists an overlay vector without completing a second target flag and rereads it aligned", () => {
  const { environment, generation, source, digest } = setupStatement();
  const before = environment.index.generation(WORKSPACE, generation.generation_id)!;
  expect(environment.index.writeStatementRelationVector(WORKSPACE, generation.generation_id, {
    root_key: source.root_key, input_digest: digest, embedding: VECTOR, token_count: 2
  })).toEqual({ status: "accepted" });
  expect(environment.index.writeStatementRelationVector(WORKSPACE, generation.generation_id, {
    root_key: source.root_key, input_digest: digest, embedding: VECTOR, token_count: 2
  })).toEqual({ status: "accepted" });
  expect(environment.index.generation(WORKSPACE, generation.generation_id)).toMatchObject({
    completed_count: before.completed_count, target_count: before.target_count
  });
  expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
  const read = environment.index.readStatementRelationVectors(WORKSPACE, [source.root_key, "missing-key"], QUERY);
  expect(read.status).toBe("ready");
  if (read.status !== "ready") throw new Error(read.reason);
  expect(read.vectors).toHaveLength(2);
  expect(read.vectors[0]).toEqual(VECTOR);
  expect(read.vectors[1]).toBeNull();
});

it("rejects a digest that is not the published relation and a retry that changes bytes", () => {
  const { environment, generation, source, digest } = setupStatement();
  expect(() => environment.index.writeStatementRelationVector(WORKSPACE, generation.generation_id, {
    root_key: source.root_key, input_digest: hashContentDigest("other relation", fieldSha256),
    embedding: VECTOR, token_count: 2
  })).toThrow(/published relation digest/u);
  expect(environment.index.writeStatementRelationVector(WORKSPACE, generation.generation_id, {
    root_key: source.root_key, input_digest: digest, embedding: VECTOR, token_count: 2
  })).toEqual({ status: "accepted" });
  expect(() => environment.index.writeStatementRelationVector(WORKSPACE, generation.generation_id, {
    root_key: source.root_key, input_digest: digest, embedding: new Float32Array([0, 1, 0]), token_count: 2
  })).toThrow(/retry differs/u);
});

it("returns nulls when the overlay was never written and unknown when the blob is corrupt", () => {
  const { environment, generation, source } = setupStatement();
  expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
  const missing = environment.index.readStatementRelationVectors(WORKSPACE, [source.root_key], QUERY);
  expect(missing).toMatchObject({ status: "ready", vectors: [null] });
  const digest = hashContentDigest("reported event", fieldSha256);
  expect(environment.index.writeStatementRelationVector(WORKSPACE, generation.generation_id, {
    root_key: source.root_key, input_digest: digest, embedding: VECTOR, token_count: 2
  }).status).toBe("accepted");
  environment.database.connection.prepare(`UPDATE source_statement_relation_vectors SET dimensions=2, embedding_blob=?
    WHERE root_key=?`).run(encodeEmbeddingBlob(new Float32Array([0.6, 0.8])), source.root_key);
  expect(environment.index.readStatementRelationVectors(WORKSPACE, [source.root_key], QUERY))
    .toMatchObject({ status: "unknown", reason: "statement_relation_vector_dimension_mismatch" });
});

it("returns unknown for an oversized overlay blob without transferring it", () => {
  const { environment, generation, source } = setupStatement();
  expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
  const blob = encodeEmbeddingBlob(new Float32Array(1024).fill(0.01));
  expect(blob.length).toBe(4096);
  environment.database.connection.prepare(`INSERT INTO source_statement_relation_vectors
    (workspace_id,generation_id,root_key,input_digest,dimensions,embedding_blob,token_count) VALUES(?,?,?,?,?,?,?)`)
    .run(WORKSPACE, generation.generation_id, source.root_key, "d".repeat(64), 1024, blob, 2);
  const read = environment.index.readStatementRelationVectors(WORKSPACE, [source.root_key], QUERY);
  expect(read).toMatchObject({ status: "unknown", reason: "statement_relation_vector_dimension_mismatch" });
  expect(read.resources.native_bytes).toBeLessThan(4096);
  expect(read.resources.memory_bytes).toBeLessThan(4096);
});

it("returns unknown for a populated overlay when the query budget is exhausted", () => {
  const { environment, generation, source, digest } = setupStatement();
  expect(environment.index.writeStatementRelationVector(WORKSPACE, generation.generation_id, {
    root_key: source.root_key, input_digest: digest, embedding: VECTOR, token_count: 2
  })).toEqual({ status: "accepted" });
  expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
  expect(environment.index.readStatementRelationVectors(WORKSPACE, [source.root_key], { work_units: 0, memory_bytes: 10_000 }))
    .toMatchObject({ status: "unknown", reason: "read_budget" });
});

it("rejects a non-blob overlay value and returns unknown for a non-finite blob without throwing", () => {
  const { environment, generation, source, digest } = setupStatement();
  expect(environment.index.writeStatementRelationVector(WORKSPACE, generation.generation_id, {
    root_key: source.root_key, input_digest: digest, embedding: VECTOR, token_count: 2
  })).toEqual({ status: "accepted" });
  expect(() => environment.database.connection.prepare(`INSERT INTO source_statement_relation_vectors
    (workspace_id,generation_id,root_key,input_digest,dimensions,embedding_blob,token_count) VALUES(?,?,?,?,?,?,?)`)
    .run(WORKSPACE, generation.generation_id, "text-key", "d".repeat(64), 3, "abcdefghijkl", 2)).toThrow();
  expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
  const nan = Buffer.alloc(12);
  nan.writeFloatLE(Number.NaN, 0);
  nan.writeFloatLE(0, 4);
  nan.writeFloatLE(0, 8);
  environment.database.connection.prepare(`UPDATE source_statement_relation_vectors SET embedding_blob=? WHERE root_key=?`)
    .run(nan, source.root_key);
  expect(environment.index.readStatementRelationVectors(WORKSPACE, [source.root_key], QUERY))
    .toMatchObject({ status: "unknown", reason: "statement_relation_invalid_vector" });
});

it("does not return ready relation text across a pre-scrub source_context erase barrier", () => {
  const environment = fixture(); opened.push(environment);
  const context = publishMessages(environment, [{ role: "user", text: "context source." }], "context-source");
  const published = publishMessages(environment);
  publishStatement(environment, published, "relation-overlay-context", 0, {}, [contextOf(context.record)]);
  const generation = environment.index.begin(environment.index.select(WORKSPACE, configuration()));
  environment.index.capturePage(WORKSPACE, generation.generation_id, 8, BUDGET);
  const targets = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
  const source = targets.find(row => row.auxiliary !== undefined);
  if (source === undefined) throw new Error("expected statement key target");
  for (const target of targets) {
    const read = environment.index.readDocument(WORKSPACE, generation.generation_id, target.root_key, 65_536, BUDGET);
    if (read.status !== "ready") throw new Error(read.reason);
    const document = prepareSourceIndexDocument({ source: target, body: read.body, profile: configuration().profile }, fieldSha256);
    expect(environment.index.writeDocument(WORKSPACE, generation.generation_id, document, BUDGET).status).toBe("accepted");
    for (const window of document.windows) {
      expect(environment.index.writeVector(WORKSPACE, generation.generation_id, {
        window_id: window.window_id, input_digest: window.content_digest, embedding: VECTOR, token_count: 2, truncated: false
      })).toEqual({ status: "accepted" });
    }
  }
  environment.database.connection.prepare(`INSERT INTO projection_erase_barriers
    (workspace_id,barrier_id,receipt_identity,generation_id,subject_kind,subject_id,erased_at)
    VALUES(?,?,?,NULL,'source_record',?,?)`)
    .run(WORKSPACE, "barrier-context", "receipt-context", context.record.record_id, CLOCK);
  expect(environment.index.readStatementRelationText(WORKSPACE, generation.generation_id, source.root_key, BUDGET).status)
    .not.toBe("ready");
});

it("returns unknown when statement relation text costs more work than the remaining budget", () => {
  const { environment, generation, source } = setupStatement();
  expect(environment.index.readStatementRelationText(WORKSPACE, generation.generation_id, source.root_key,
    { work: 2, native_bytes: 10_000 })).toMatchObject({ status: "unknown", reason: "statement_relation_text_read_budget" });
});

it("does not queue an ordinary source_record whose source_id contains :statement:", () => {
  const environment = fixture(); opened.push(environment);
  publishSource(environment, "plain body", "foo:statement:bar");
  const generation = environment.index.begin(environment.index.select(WORKSPACE, configuration()));
  environment.index.capturePage(WORKSPACE, generation.generation_id, 8, BUDGET);
  const targets = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8);
  expect(targets.some(row => row.auxiliary !== undefined)).toBe(false);
  expect(targets.some(row => row.source_id?.includes(":statement:"))).toBe(true);
  expect(environment.database.connection.prepare(
    "SELECT count(*) AS n FROM source_statement_relation_pending").get()).toEqual({ n: 0 });
  const next = environment.index.nextStatementRelationOverlayTarget(WORKSPACE, generation.generation_id, null, BUDGET);
  expect(next).toMatchObject({ status: "ready", root_key: null, resources: { work: 2 } });
});

it("refuses overlay target lookup before transferring a root_key when work or native bytes cannot cover the two reads", () => {
  const { environment, generation, source } = setupStatement();
  expect(source.root_key.length).toBeGreaterThan(1);
  expect(environment.database.connection.prepare(
    "SELECT count(*) AS n FROM source_statement_relation_pending").get()).toEqual({ n: 1 });
  expect(environment.index.nextStatementRelationOverlayTarget(WORKSPACE, generation.generation_id, null,
    { work: 1, native_bytes: 10_000 })).toMatchObject({
    status: "resource_exhausted", reason: "overlay_target_read_budget", resources: { work: 0, native_bytes: 0 } });
  const tiny = environment.index.nextStatementRelationOverlayTarget(WORKSPACE, generation.generation_id, null,
    { work: 10, native_bytes: 1 });
  expect(tiny).toMatchObject({ status: "resource_exhausted", reason: "overlay_target_read_budget",
    resources: { work: 0, native_bytes: 0 } });
  expect(tiny).not.toHaveProperty("root_key");
  const scalarOnly = environment.index.nextStatementRelationOverlayTarget(WORKSPACE, generation.generation_id, null,
    { work: 10, native_bytes: 20 });
  expect(scalarOnly).toMatchObject({ status: "resource_exhausted", reason: "overlay_target_read_budget",
    resources: { work: 2, native_bytes: 16 } });
});

it("keeps a pending overlay row on partial source unavailability and seeds pre-047 statement targets", () => {
  const { environment, generation, source } = setupStatement();
  environment.database.connection.prepare("UPDATE source_records SET source_body=NULL, retained_content_bytes=8 WHERE workspace_id=?")
    .run(WORKSPACE);
  const partialRead = environment.index.readStatementRelationText(WORKSPACE, generation.generation_id, source.root_key, BUDGET);
  expect(partialRead).toMatchObject({ status: "unknown", reason: "native_source_unavailable" });
  expect(environment.database.connection.prepare(
    "SELECT count(*) AS n FROM source_statement_relation_pending").get()).toEqual({ n: 1 });
  // Simulate pre-047 state by clearing pending and re-running the 047 seeding INSERT.
  environment.database.connection.prepare("DELETE FROM source_statement_relation_pending").run();
  environment.database.connection.prepare(`INSERT OR IGNORE INTO source_statement_relation_pending (workspace_id, generation_id, root_key)
    SELECT t.workspace_id, t.generation_id, t.root_key
    FROM source_index_targets t
    JOIN source_index_roots r ON r.workspace_id = t.workspace_id AND r.root_key = t.root_key
    JOIN source_index_generations g ON g.workspace_id = t.workspace_id AND g.generation_id = t.generation_id
    WHERE g.status NOT IN ('retired', 'failed') AND json_type(r.target_json, '$.auxiliary') = 'object'`).run();
  expect(environment.database.connection.prepare(
    "SELECT count(*) AS n FROM source_statement_relation_pending").get()).toEqual({ n: 1 });
});

it("dequeues a pending overlay row when the vector is accepted", () => {
  const { environment, generation, source, digest } = setupStatement();
  expect(environment.database.connection.prepare(
    "SELECT count(*) AS n FROM source_statement_relation_pending").get()).toEqual({ n: 1 });
  expect(environment.index.writeStatementRelationVector(WORKSPACE, generation.generation_id, {
    root_key: source.root_key, input_digest: digest, embedding: VECTOR, token_count: 2
  })).toEqual({ status: "accepted" });
  expect(environment.database.connection.prepare(
    "SELECT count(*) AS n FROM source_statement_relation_pending").get()).toEqual({ n: 0 });
  expect(environment.index.nextStatementRelationOverlayTarget(WORKSPACE, generation.generation_id, null, BUDGET))
    .toMatchObject({ status: "ready", root_key: null, resources: { work: 2 } });
});

it("reclaims overlay rows with the retired generation", () => {
  const { environment, generation, source, digest } = setupStatement();
  expect(environment.index.writeStatementRelationVector(WORKSPACE, generation.generation_id, {
    root_key: source.root_key, input_digest: digest, embedding: VECTOR, token_count: 2
  })).toEqual({ status: "accepted" });
  expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
  const next = environment.index.begin(environment.index.select(WORKSPACE, configuration({ model_revision: "v2" })));
  environment.index.capturePage(WORKSPACE, next.generation_id, 8, BUDGET);
  for (const target of environment.index.listTargets(WORKSPACE, next.generation_id, null, 8)) {
    const read = environment.index.readDocument(WORKSPACE, next.generation_id, target.root_key, 65_536, BUDGET);
    if (read.status !== "ready") throw new Error(read.reason);
    const document = prepareSourceIndexDocument({ source: target, body: read.body, profile: next.selection.configuration.profile }, fieldSha256);
    expect(environment.index.writeDocument(WORKSPACE, next.generation_id, document, BUDGET).status).toBe("accepted");
    for (const window of document.windows) {
      expect(environment.index.writeVector(WORKSPACE, next.generation_id, {
        window_id: window.window_id, input_digest: window.content_digest, embedding: VECTOR, token_count: 2, truncated: false
      })).toEqual({ status: "accepted" });
    }
  }
  expect(environment.index.activate(WORKSPACE, next.generation_id)).toEqual({ status: "accepted" });
  const pages = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const page = environment.index.reclaimVectorPage(WORKSPACE, 8, BUDGET);
    pages.push(page);
    if (page.complete) break;
  }
  expect(pages.some(page => page.relation_vectors > 0)).toBe(true);
  expect(environment.database.connection.prepare(
    "SELECT count(*) AS n FROM source_statement_relation_vectors").get()).toEqual({ n: 0 });
});
