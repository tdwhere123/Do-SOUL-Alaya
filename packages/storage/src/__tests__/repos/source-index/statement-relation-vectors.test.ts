import { afterEach, expect, it } from "vitest";
import { hashContentDigest, prepareSourceIndexDocument } from "@do-soul/alaya-protocol";
import { encodeEmbeddingBlob } from "../../../repos/memory/embedding-vector-validity.js";
import { BUDGET, WORKSPACE, configuration, fieldSha256, fixture, type Fixture } from "./source-index-fixture.js";
import { publishMessages, publishStatement } from "./source-template-fixture.js";

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
    .toMatchObject({ status: "unknown", reason: "statement_relation_incompatible_dimensions" });
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
