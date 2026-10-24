import { join } from "node:path";
import Database from "better-sqlite3";
import { expect } from "vitest";
import { SoulMemorySearchRequestSchema, SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION } from "@do-soul/alaya-protocol";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { BENCH_DAEMON_DB_FILENAME, restoreSnapshotToDataDir } from "../../../runs/snapshot/materialize.js";
import { QuestionPublicationSchema, type replayLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/execute.js";
import type { measureLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/measure.js";
import { readChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { ReplaySchema } from "../../../runs/recall-measurement/replay.js";
import type { SourceCensusRecord } from "../../../runs/snapshot/source-records/census.js";
import { prepareSourceRecordLexicalIndex, recallSourcePages } from "../../harness/recall/source-records-worker-fixture.js";

/** Publication seals original records, not a query-ready index or a source-gold score. */
export async function expectPublishedSourceDelivery(root: string, value: unknown, originals: readonly SourceCensusRecord[]) {
  const report = QuestionPublicationSchema.parse(value);
  expect(report.sources).toHaveLength(originals.length);
  expect(originals.length).toBeGreaterThan(0);
  restoreSnapshotToDataDir({ snapshotDbPath: report.snapshot_path, dataDirRoot: root, expectedSha256: report.db_sha256 });
  const daemon = await startBenchDaemon({ dataDirRoot: root, workspaceId: report.workspace_id,
    runId: report.run_id, embeddingMode: "disabled" });
  try {
    const db = new Database(join(root, BENCH_DAEMON_DB_FILENAME), { readonly: true });
    try {
      for (const original of originals) {
        const source = report.sources.find(row => row.source_id === original.source_id);
        expect(source).toMatchObject({ admission: "admitted", source_version: original.source_version,
          content_digest: original.content_digest, corpus_digest: original.corpus_digest, record_id: expect.any(String) });
        expect(db.prepare("SELECT source_body, source_version, content_digest, workspace_id, event_time FROM source_records WHERE record_id = ?")
          .get(source!.record_id)).toEqual({ source_body: original.content_bytes, source_version: original.source_version,
            content_digest: original.content_digest, workspace_id: report.workspace_id, event_time: original.source_observed_at });
        expect((db.prepare("SELECT count(*) AS n FROM event_log WHERE entity_type = 'source_record' AND entity_id = ?")
          .get(source!.record_id) as { n: number }).n).toBeGreaterThan(0);
      }
      for (const table of ["memory_entries", "evidence_capsules"]) {
        expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    } finally { db.close(); }
    prepareSourceRecordLexicalIndex(daemon.dataDir, report.workspace_id);
    const read = await recallSourcePages(daemon, SoulMemorySearchRequestSchema.parse({
      query: originals.map(row => row.content_bytes).join(" "), max_results: 20, result_kind_view: "source_only",
      enumeration_policy: "native_query", scope_class: null, dimension: null, domain_tags: null,
      source_observed_at: "2023-09-13T00:00:00.000Z", protocol_version: 1, supports_source_evidence: true,
      supported_result_kinds: ["source_evidence"], supports_product_updates: true
    }));
    expect(new Set(read.results.flatMap(row => row.target.kind === "source_evidence" ? [row.target.root_id] : [])))
      .toEqual(new Set(report.sources.map(row => row.record_id)));
    for (const result of read.results) {
      const target = result.target;
      if (target.kind !== "source_evidence") throw new Error("native source delivery required");
      const source = report.sources.find(row => row.record_id === target.root_id)!;
      expect(target).toMatchObject({ workspace_id: report.workspace_id, root_kind: "source_record",
        source_version: source.source_version, content_digest: source.content_digest, evidence_object_id: null });
      expect(result.content_preview).toBe(originals.find(row => row.source_id === source.source_id)!.content_bytes);
    }
    expect(read.pages.flatMap(page => page.index?.entries ?? []).every(entry => entry.navigation?.operator === "source_lexical")).toBe(true);
    expect(new Set(read.pages.map(page => page.index?.snapshot_id)).size).toBe(1);
    expect(read.response.index?.completeness.logical_index).toBe("open");
    expect(read.response.index?.completeness.interpretation_coverage).toBe("open");
  } finally { await daemon.shutdown(); }
}

/** A current field page is a known refusal, never a measured miss or empty gold. */
export function expectArchivedFieldRefusal(row: Awaited<ReturnType<typeof measureLongMemEvalSemanticRun>>["result"]["rows"][number],
  replay: Awaited<ReturnType<typeof replayLongMemEvalSemanticRun>>["result"]) {
  const member = replay.rows.find(member => member.question_id === row.question_id);
  if (member?.status !== "replayed") throw new Error("native replay required for archived family refusal");
  const archived = ReplaySchema.parse(readChainArtifact(member.replay_path));
  expect(archived.rows).toHaveLength(1);
  expect(archived.rows[0]).toMatchObject({ status: "replayed", first_exposure: null, response: {
    operation: "recall", protocol_version: SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION
  } });
  expect(row).toMatchObject({ outcome: row.cohort === "abstention" ? "uncalibrated" : "unknown", reason: "invalid_response",
    mechanism: "not_exercised", measurement_path: expect.any(String), attribution: { layer: "invalid_measurement", native: {
      measurement: { status: "invalid", reason: "invalid_response" }, reason: "invalid_response",
      preparation_elapsed_ms: archived.rows[0]!.preparation_elapsed_ms,
      diagnostics: { native_elapsed_ms: archived.rows[0]!.native_elapsed_ms, work: expect.any(Object) }
    } } });
  expect(row.acquisition?.costs.observed.preparation_elapsed).toMatchObject({ status: "known", value: expect.any(Number) });
  expect(row.acquisition?.costs.observed.native_work).toMatchObject({ status: "known", value: expect.any(Number) });
  expect(readChainArtifact(row.measurement_path!)).toMatchObject({ gold: [{ source_units: null }], rows: [{
    measurement: { status: "invalid", reason: "invalid_response" },
    evaluator_usage: { proof_slots_checked: 0, work_units: 0, logical_memory_bytes: 0 },
    mechanism: { status: "unexercised", validated_proof_ranks: [] }
  }] });
}
