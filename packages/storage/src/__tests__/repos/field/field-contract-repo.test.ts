import { afterEach, describe, expect, it } from "vitest";
import type { StorageDatabase } from "../../../sqlite/db.js";
import {
  SqliteFieldCausalUsageRepo,
  SqliteFieldDerivationJobRepo,
  SqliteFieldFactorRepo,
  SqliteFieldProjectionGenerationRepo,
  SqliteFieldSourceRecordRepo,
  SqliteFieldSourceSpanRepo
} from "../../../repos/field/index.js";
import {
  fieldSha256,
  hashedFactor,
  hashedGeneration,
  hashedIncidence,
  hashedJob,
  hashedRecord,
  hashedSpan,
  hashedUsage,
  openFieldDatabase
} from "./field-contract-fixture.js";

const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("field contract repos", () => {
  it("admits the same source bytes in two workspaces without collision", () => {
    const { records } = createRepos();
    const left = records.insert(hashedRecord("workspace-1", "shared body"));
    const right = records.insert(hashedRecord("workspace-2", "shared body"));

    expect(left.record_id).toBe(right.record_id);
    expect(records.findById("workspace-1", left.record_id)?.source_body).toBe("shared body");
    expect(records.findById("workspace-2", right.record_id)?.source_body).toBe("shared body");
    expect(records.findById("workspace-2", left.record_id)?.workspace_id).toBe("workspace-2");
    expect(records.findById("workspace-1", "missing")).toBeNull();
  });

  it("round-trips protocol-hashed record and generation identities", () => {
    const { records, generations } = createRepos();
    const record = hashedRecord("workspace-1", "visible body");
    const generation = hashedGeneration("workspace-1", "event-1", "shadow");

    expect(records.insert(record).record_id).toBe(record.record_id);
    expect(generations.insert(generation).generation_id).toBe(generation.generation_id);
    expect(generations.readPinned("workspace-1", generation.generation_id)).toEqual(generation);
    expect(() => generations.insert({
      ...generation,
      operator_manifest_digest: `sha256:${"c".repeat(64)}`
    })).toThrow(/identity|manifest|operator/u);
  });

  it("requires a matching workspace for find, status, and erase subjects", () => {
    const { records, generations } = createRepos();
    const record = records.insert(hashedRecord("workspace-1", "visible body"));
    const generation = generations.insert(hashedGeneration("workspace-1", "event-1", "shadow"));

    expect(records.findById("workspace-2", record.record_id)).toBeNull();
    expect(generations.readPinned("workspace-2", generation.generation_id)).toBeNull();
    expect(() => generations.persistStatus(
      "workspace-2",
      generation.generation_id,
      "retired"
    )).toThrow(/missing|NOT_FOUND|workspace/u);
  });

  it("transitions derivation jobs and rejects a second natural key", () => {
    const { database, jobs } = createRepos();
    const nominated = jobs.insert(hashedJob("workspace-1", ["ev-b", "ev-a"]));
    const running = jobs.persistStatus(
      "workspace-1",
      nominated.job_id,
      "nominated",
      "running"
    );
    expect(running.status).toBe("running");
    expect(jobs.insert(hashedJob("workspace-1", ["ev-a", "ev-b"])).status).toBe("running");
    expect(() => database.connection.prepare(`
      INSERT INTO derivation_jobs (
        job_id, workspace_id, purpose, operator_id, input_evidence_ids_json,
        status, disposition, recorded_at
      ) VALUES ('job-forged', 'workspace-1', ?, ?, ?, 'nominated', 'pending', ?)
    `).run(
      nominated.purpose,
      nominated.operator_id,
      nominated.input_evidence_ids_json,
      nominated.recorded_at
    )).toThrow(/UNIQUE/u);
    expect(jobs.findById("workspace-2", nominated.job_id)).toBeNull();
  });

  it("isolates generations and keeps mixed-generation reads fail-closed", () => {
    const { generations } = createRepos();
    const first = generations.insert(hashedGeneration("workspace-1", "event-1", "shadow"));
    const second = generations.insert(hashedGeneration("workspace-1", "event-2", "shadow"));
    expect(() => generations.insert({ ...first, status: "active" })).toThrow(/pointer swap/u);
    expect(() => generations.readByGenerationIds("workspace-1", [
      first.generation_id,
      second.generation_id
    ])).toThrow(/mixed generation/u);
  });

  it("stores incidences under workspace-qualified keys", () => {
    const { records, spans, factors } = createRepos();
    const record = records.insert(hashedRecord("workspace-1", "body"));
    const span = spans.insert(hashedSpan("workspace-1", record.record_id));
    const factor = factors.insertDescriptor(hashedFactor("workspace-1", "token"));
    const incidence = factors.insertIncidence(hashedIncidence(
      "workspace-1",
      span.span_id,
      factor.factor_id,
      "workspace-1"
    ));
    expect(factors.findIncidence("workspace-1", incidence.incidence_id)?.scope)
      .toBe("workspace-1");
    expect(factors.findIncidence("workspace-2", incidence.incidence_id)).toBeNull();
  });

  it("rejects delivery learning and keeps causal usage workspace-local", () => {
    const { usage } = createRepos();
    const causal = usage.insert(hashedUsage("workspace-1", "use-1"));
    expect(usage.findById("workspace-1", causal.identity)?.usage_kind).toBe("causal");
    expect(usage.findById("workspace-2", causal.identity)).toBeNull();
    expect(() => usage.insert({
      ...hashedUsage("workspace-1", "use-2"),
      usage_kind: "delivery",
      weight: 0.2
    })).toThrow(/check failed|CHECK constraint failed|weight/u);
  });

  it("lists workspace rows through parsers and refuses a null-payload factor wildcard", () => {
    const { records, factors } = createRepos();
    const record = records.insert(hashedRecord("workspace-1", "listed body"));
    const live = factors.insertDescriptor(hashedFactor("workspace-1", "atlas"));
    expect(records.listByWorkspace("workspace-1").map((row) => row.record_id))
      .toEqual([record.record_id]);
    expect(factors.listDescriptors("workspace-1")).toEqual([live]);
    expect(() => factors.insertDescriptor({
      ...live,
      canonical_payload: null
    })).toThrow(/factor|payload|VALIDATION/u);
  });
});

function createRepos() {
  const database = openFieldDatabase();
  tracked.add(database);
  return {
    database,
    records: new SqliteFieldSourceRecordRepo(database, fieldSha256),
    spans: new SqliteFieldSourceSpanRepo(database, fieldSha256),
    factors: new SqliteFieldFactorRepo(database, fieldSha256),
    jobs: new SqliteFieldDerivationJobRepo(database, fieldSha256),
    generations: new SqliteFieldProjectionGenerationRepo(database, fieldSha256),
    usage: new SqliteFieldCausalUsageRepo(database, fieldSha256)
  };
}
