import { expect, it } from "vitest";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import { SqliteSourceIndexRepository } from "../../../../storage/src/repos/source-index/source-index-repo.js";
import { BUDGET, WORKSPACE, captureDocuments, configuration, fieldSha256, fixture, publishSource } from
  "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { digest } from "./source-index-acquisition-fixture.js";

it("sizes shared metadata once while preserving exact scores, scope decisions, and the 768-window prefix", () => {
  const environment = fixture(), { database, index } = environment;
  try {
    for (const [id, text] of [["best", "a"], ["denied", "b"], ["negative", "c"]]) {
      publishSource(environment, text!.repeat(2048), id);
    }
    const config = configuration({ dimensions: 384, window_bytes: 8 });
    const selection = index.select(WORKSPACE, config), generation = index.begin(selection);
    const documents = captureDocuments(environment, generation);
    expect(documents.map(document => document.windows.length)).toEqual([256, 256, 256]);
    const vectors: Record<string, Float32Array> = {};
    for (const id of ["best", "denied", "negative"]) vectors[id] = new Float32Array(384);
    vectors.best![0] = 3; vectors.best![1] = 4;
    vectors.denied![1] = 1; vectors.negative![0] = -1;
    database.connection.transaction(() => {
      for (const document of documents) for (const window of document.windows) {
        expect(index.writeVector(WORKSPACE, generation.generation_id, { window_id: window.window_id,
          input_digest: window.content_digest, embedding: vectors[document.source.source_id!]!, token_count: 2, truncated: false }))
          .toEqual({ status: "accepted" });
      }
    })();
    expect(index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
    let targetLengths = 0;
    database.connection.function("octet_length", { deterministic: true }, (value: string | Buffer | null) => {
      if (typeof value === "string" && value.includes('"root_key"')) targetLengths++;
      return value === null ? null : Buffer.byteLength(value);
    });
    const captured = new SqliteSourceIndexRepository(database, fieldSha256, { captureReadTargets: true });
    const query = new Float32Array(384); query[0] = 1;
    const input = { workspace_id: WORKSPACE, navigation_text: "needle", allowance: {
      max_attempts: 8, max_roots: 8, max_vector_windows: 1024 },
      budget: { work_units: 5_000_000, memory_bytes: 32 * 1024 * 1024 }, vector: {
        status: "available" as const, profile: config.profile, profile_id: selection.profile_id,
        input_digest: digest("needle"), embedding: query } };
    const result = database.connection.transaction(() => new SourceIndexAcquisition(captured, fieldSha256)
      .nominate(input, (_scope, source) => source.source_id === "denied" ? "denied" : "admitted"))();
    expect(result.vector).toMatchObject({ completion: "complete", inspected_windows: 768, invalid_windows: 0,
      ranking: "exact_over_inspected_subset" });
    expect(result.nominations.map(row => [row.source.source_id, row.vector?.rank, row.vector?.cosine]))
      .toEqual([["best", 1, 0.6], ["negative", 3, -1]]);
    expect(result.accounting).toMatchObject({ attempted: 3, admitted: 2, scope_denied: 1 });
    expect(result.resources.work).toBeLessThanOrEqual(input.budget.work_units);
    expect(result.resources.memory_bytes).toBeLessThanOrEqual(input.budget.memory_bytes);
    // SQL evaluates the target's UTF-8 length once per root instead of once per window.
    expect(targetLengths).toBe(3);
    targetLengths = 0;
    const formerPage = database.connection.prepare(`SELECT v.window_id,octet_length(r.target_json) AS target_bytes
      FROM source_index_vectors v JOIN source_index_windows w ON w.workspace_id=v.workspace_id
        AND w.generation_id=v.generation_id AND w.root_key=v.root_key AND w.window_id=v.window_id
      JOIN source_index_targets t ON t.workspace_id=v.workspace_id AND t.generation_id=v.generation_id AND t.root_key=v.root_key
      JOIN source_index_roots r ON r.workspace_id=v.workspace_id AND r.root_key=v.root_key
      WHERE v.workspace_id=? AND v.generation_id=? AND v.window_id>? ORDER BY v.window_id ASC LIMIT ?`)
      .all(WORKSPACE, generation.generation_id, "", 1024);
    expect(formerPage).toHaveLength(768);
    expect(targetLengths).toBe(768);
  } finally { database.close({ optimize: false }); }
}, 60_000);
