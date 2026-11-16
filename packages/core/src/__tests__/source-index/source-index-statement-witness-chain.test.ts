import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => {
  expect(isolation.violations).toEqual([]);
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});
afterAll(() => isolation.restore());
import type {
  SourceIndexAcquisitionInput, SourceIndexLexicalRead, SourceIndexQueryRepository, SourceIndexStatementWitnessRead,
  SourceIndexTarget, SourceIndexVectorBinding, SourceIndexVectorRead
} from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import type { EvidenceDemands } from "../../source-index/statement-association.js";
import { configuration, fieldSha256, fixture, type Fixture }
  from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { AXIS_ROOTS, admitScope, publishIndex, queryInput } from "./source-index-acquisition-fixture.js";
import { templateBudget, templateStatement } from "./source-template-fixture.js";

const empty = { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const };
const environments: Fixture[] = [];
const demands: EvidenceDemands = { status: "ready", vectors: [Float32Array.of(1, 0)],
  conditions: [{ statement: "s", speaker: "user", anchors: [] }] };

function lexicalOf(rows: readonly ReturnType<typeof templateStatement>[]): SourceIndexLexicalRead {
  return { completion: "complete", reason: null,
    candidates: rows.map((row, i) => ({ source: row.source, lexical: { lane: "unicode61", rank: i + 1, lane_rank: i + 1, bm25: -1 } })),
    resources: empty, resource_refusal: null, index_coverage: "partial", limitations: [], tokenization: null };
}

function readyWitness(keys: readonly SourceIndexTarget[], resources = empty): SourceIndexStatementWitnessRead {
  return { status: "ready", resources, session_time: null, inventory: { status: "unknown" },
    witnesses: keys.map(() => ({ role: "user", anchors: [], statement: "" })) };
}

describe("statement witness association through snapshot nomination", () => {
  it("reads nominated roots in admission order after nomination and absorbs only defined reads", () => {
    const rows = [templateStatement("root-a"), templateStatement("root-b")];
    const calls: string[] = [];
    const readResources = { work: 4, memory_bytes: 16, native_bytes: 9, sql_internal_work: "unknown" as const };
    const repository: SourceIndexQueryRepository = {
      readLexicalCandidates: () => lexicalOf(rows),
      readVectorCandidates: () => ({ completion: "complete", reason: null, candidates: [], resources: empty,
        state: { status: "unavailable", reason: "fixture" }, resource_refusal: null, cursor: null, inspected: 0, invalid: 0 }),
      admitQueryCandidate: () => ({ status: "ready", scope_class: "project", resources: empty }),
      readStatementWitnesses: (source, keys) => {
        calls.push(`${source.source_id}:${keys.length}`);
        return readyWitness(keys, readResources);
      }
    };
    const input: SourceIndexAcquisitionInput = { workspace_id: "workspace-template", navigation_text: "game",
      vector: { status: "unavailable", reason: "fixture" }, allowance: { max_attempts: 8, max_roots: 8, max_vector_windows: 0 },
      budget: templateBudget };
    const original = new SourceIndexAcquisition(repository, fieldSha256)
      .nominateWithWitness(input, () => "admitted", "original", undefined, demands);
    expect(original.result.nominations.map(row => row.source.source_id)).toEqual(["root-a", "root-b"]);
    expect(calls).toEqual(["root-a:0", "root-b:0"]);
    expect(original.association?.roots).toEqual(original.result.nominations.map(row => row.source.root_key));
    expect(original.result.resources.native_bytes).toBe(18);
    expect(original.result.resources.work).toBeGreaterThan(8);
    calls.length = 0;
    const hint = new SourceIndexAcquisition(repository, fieldSha256)
      .nominateWithWitness(input, () => "admitted", "hint", undefined, demands);
    expect(calls).toEqual([]);
    expect(hint.association).toBeUndefined();
    expect(hint.result.nominations.map(row => row.source.source_id)).toEqual(["root-a", "root-b"]);
  });

  it("passes retained statement keys to the reader and stops later roots after an unknown keyed read", () => {
    const rows = [templateStatement("keyed-a"), templateStatement("keyed-b")];
    const config = configuration();
    const input = queryInput(config, { workspace_id: "workspace-template",
      allowance: { max_attempts: 8, max_roots: 8, max_vector_windows: 8 } });
    if (input.vector.status !== "available") throw new Error("expected available query vector");
    const binding: SourceIndexVectorBinding = {
      workspace_id: input.workspace_id, selection_revision: 1, config_id: "cfg",
      profile_id: input.vector.profile_id, generation_id: "gen", source_epoch: 1, dimensions: 3
    };
    const page: SourceIndexVectorRead = {
      candidates: rows.map((row, index) => ({ source: row.statement.source,
        window: { window_id: `window-${index}`, start_byte: 0, end_byte: 8, content_digest: "sha256:w" },
        embedding: index === 0 ? Float32Array.of(1, 0, 0) : Float32Array.of(0, 1, 0) })),
      completion: "complete", reason: null, resources: empty, state: { status: "ready", binding },
      resource_refusal: null, cursor: null, inspected: 2, invalid: 0
    };
    const order: string[] = [];
    const unknownResources = { work: 3, memory_bytes: 8, native_bytes: 5, sql_internal_work: "unknown" as const };
    const repository: SourceIndexQueryRepository = {
      readLexicalCandidates: () => lexicalOf([]),
      readVectorCandidates: () => page,
      admitQueryCandidate: () => ({ status: "ready", scope_class: "project", resources: empty }),
      readStatementWitnesses: (source, keys) => {
        order.push(`${source.source_id}:${keys.map(key => key.auxiliary?.artifact_id).join(",")}`);
        if (keys.length === 0) return readyWitness(keys);
        if (order.filter(entry => entry.includes(":artifact-")).length === 1) {
          return { status: "unknown", reason: "statement_witness_message_binding", resources: unknownResources };
        }
        throw new Error("later roots must not be read after a keyed unknown");
      }
    };
    // Statement-key and evidence vectors share the selected query profile (three dimensions).
    const keyedDemands: EvidenceDemands = { ...demands, vectors: [Float32Array.of(1, 0, 0)] };
    const capture = new SourceIndexAcquisition(repository, fieldSha256)
      .nominateWithWitness(input, () => "admitted", "original", undefined, keyedDemands);
    expect(capture.result.vector.validation).toBe("validated");
    expect(capture.result.vector.inspected_windows).toBe(2);
    expect(capture.result.nominations.map(row => row.source.source_id)).toEqual(["keyed-a", "keyed-b"]);
    expect(capture.result.resource_refusals).toEqual([]);
    expect(order).toHaveLength(1);
    expect(order[0]).toBe("keyed-a:artifact-keyed-a");
    expect(capture.association).toBeUndefined();
    expect(capture.result.resource_refusals.map(row => row.phase)).not.toContain("statement_witness_message_binding");
    expect(capture.result.resources.native_bytes).toBe(5);
  });
});

describe("statement witness reader on a real SQLite snapshot", () => {
  it("invokes the native reader with nominated sources after the snapshot nomination, not before", () => {
    const environment = fixture();
    environments.push(environment);
    publishIndex(environment, [AXIS_ROOTS[0]!, AXIS_ROOTS[1]!]);
    const events: string[] = [];
    const admit = environment.index.admitQueryCandidate.bind(environment.index);
    const native = environment.index.readStatementWitnesses.bind(environment.index);
    vi.spyOn(environment.index, "admitQueryCandidate").mockImplementation((source, binding, budget) => {
      events.push(`admit:${source.source_id}`);
      return admit(source, binding, budget);
    });
    vi.spyOn(environment.index, "readStatementWitnesses").mockImplementation((source, keys, anchors, budget) => {
      events.push(`read:${source.source_id}`);
      return native(source, keys, anchors, budget);
    });
    const input = queryInput(configuration(), { vector: { status: "unavailable", reason: "not_requested" } });
    const capture = environment.database.connection.transaction(() =>
      new SourceIndexAcquisition(environment.index, fieldSha256)
        .nominateWithWitness(input, admitScope, "original", undefined, demands))();
    const reads = events.filter(event => event.startsWith("read:"));
    expect(reads).toEqual(capture.result.nominations.map(row => `read:${row.source.source_id}`));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      const admitted = `admit:${read.slice("read:".length)}`;
      expect(events.indexOf(admitted)).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(admitted)).toBeLessThan(events.indexOf(read));
    }
    expect(capture.association?.roots).toEqual(capture.result.nominations.map(row => row.source.root_key));
  });
});
