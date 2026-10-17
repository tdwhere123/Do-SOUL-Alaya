import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
  sourceIndexProfileId, type SourceIndexAcquisitionInput, type SourceIndexAcquisitionResult,
  type SourceIndexConfiguration, type SourceIndexScopeAdmission
} from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import {
  WORKSPACE, captureDocuments, configuration, fieldSha256, publishSource, type Fixture
} from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";

export const QUERY_BUDGET = { work_units: 2_000_000, memory_bytes: 8 * 1024 * 1024 };
export const NAVIGATION = "needle";
export const admitScope: SourceIndexScopeAdmission = () => "admitted";
export const digest = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

export type RootSpec = Readonly<{
  id: string; body: string; vectors: readonly (readonly number[])[];
  scope?: "project" | "global_domain" | "global_core";
}>;

// All values are independently authored controls, not output from an embedding model.
export const AXIS_ROOTS: readonly RootSpec[] = [
  { id: "lexical", body: "needle a", vectors: [[3, 4, 0]], scope: "project" },
  { id: "overlap", body: "needle b", vectors: [[0, 0, 2]], scope: "global_core" },
  { id: "vector-only", body: "oceanbayoceanbay", vectors: [[4, 0, 0], [0, 5, 0]], scope: "project" },
  { id: "tie", body: "desertxxdesertxx", vectors: [[3, 4, 0], [6, 8, 0]], scope: "project" },
  { id: "negative", body: "tundraxx", vectors: [[-2, 0, 0]], scope: "project" }
];

export function publishIndex(environment: Fixture, specs: readonly RootSpec[] = AXIS_ROOTS,
  config: SourceIndexConfiguration = configuration()) {
  const records = specs.map(spec => publishSource(environment, spec.body, spec.id, { scope_class: spec.scope ?? "project" }));
  const generation = environment.index.begin(environment.index.select(WORKSPACE, config));
  const documents = captureDocuments(environment, generation);
  for (const document of documents) {
    const spec = specs.find(candidate => candidate.id === document.source.source_id)!;
    expect(document.windows).toHaveLength(spec.vectors.length);
    for (const window of document.windows) {
      expect(environment.index.writeVector(WORKSPACE, generation.generation_id, {
        window_id: window.window_id, input_digest: window.content_digest,
        embedding: new Float32Array(spec.vectors[window.ordinal]!), token_count: 2, truncated: false
      })).toEqual({ status: "accepted" });
    }
  }
  expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
  return { generation, documents, records, config };
}

export function queryInput(config = configuration(), changes: Partial<SourceIndexAcquisitionInput> = {}): SourceIndexAcquisitionInput {
  return { workspace_id: WORKSPACE, navigation_text: NAVIGATION, allowance: {
    max_attempts: 16, max_roots: 8, max_vector_windows: 64
  }, budget: { ...QUERY_BUDGET }, vector: {
    status: "available", profile: config.profile, profile_id: sourceIndexProfileId(config.profile, fieldSha256),
    input_digest: digest(NAVIGATION), embedding: new Float32Array([5, 0, 0])
  }, ...changes };
}

export function query(environment: Fixture, input: SourceIndexAcquisitionInput, scope: SourceIndexScopeAdmission) {
  // Caller-owned real SQLite snapshot; no daemon lease or deadline claim is made here.
  return environment.database.connection.transaction(() => new SourceIndexAcquisition(environment.index, fieldSha256)
    .nominate(input, scope))();
}

export function expectBounded(result: SourceIndexAcquisitionResult, input: SourceIndexAcquisitionInput) {
  expect(result.policy).toBe("source-index-interleaved-prefix.v1");
  expect(result.accounting.attempted).toBeLessThanOrEqual(input.allowance.max_attempts);
  expect(result.accounting.admitted).toBeLessThanOrEqual(input.allowance.max_roots);
  expect(result.accounting.attempted).toBe(result.accounting.admitted + result.accounting.duplicate + result.accounting.rejected);
  expect(result.nominations).toHaveLength(result.accounting.admitted);
  expect(new Set(result.nominations.map(candidate => candidate.source.root_key)).size).toBe(result.nominations.length);
  expect(result.vector.inspected_windows).toBeLessThanOrEqual(input.allowance.max_vector_windows);
  expect(result.resources.sql_internal_work).toBe("unknown");
  for (const [spent, bound] of [[result.resources.work, input.budget.work_units],
    [result.resources.memory_bytes, input.budget.memory_bytes]] as const) {
    expect(Number.isSafeInteger(spent)).toBe(true);
    expect(spent).toBeGreaterThanOrEqual(0);
    expect(spent).toBeLessThanOrEqual(bound);
  }
  expect(result.resources.native_bytes).toBeGreaterThanOrEqual(0);
  expect(result.resources.native_bytes).toBeLessThanOrEqual(result.resources.memory_bytes);
}

export function expectMetadataOnly(result: SourceIndexAcquisitionResult, bodies: readonly string[]) {
  const visit = (value: unknown): void => {
    expect(ArrayBuffer.isView(value)).toBe(false);
    expect(value instanceof ArrayBuffer).toBe(false);
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      expect(["body", "text", "embedding", "embedding_blob", "navigation_text"]).not.toContain(key);
      visit(child);
    }
  };
  visit(result);
  for (const body of bodies) expect(JSON.stringify(result)).not.toContain(body);
  for (const nomination of result.nominations) {
    expect(Object.keys(nomination).sort()).toEqual(["lexical", "source", "vector"]);
    expect(Object.keys(nomination.source).sort()).toEqual(["body_bytes", "root_key", "source_id", "target"]);
    if (nomination.vector !== null) {
      expect(Object.keys(nomination.vector).sort()).toEqual(["cosine", "rank", "window"]);
      expect(Object.keys(nomination.vector.window).sort()).toEqual(["content_digest", "end_byte", "start_byte", "window_id"]);
    }
  }
}
