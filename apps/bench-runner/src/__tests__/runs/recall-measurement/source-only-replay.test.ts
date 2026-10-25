import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sourceSemanticAccessPhases } from "@do-soul/alaya-protocol";
import { prepareNativeSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-cache/workset.js";
import { prepareSemanticChain } from "../../../runs/recall-measurement/prepare.js";
import { replaySemanticChain, measureSemanticChain, ReplaySchema } from "../../../runs/recall-measurement/replay.js";
import { SemanticChainConfigSchema, assertChainSnapshot } from "../../../runs/recall-measurement/contract.js";
import { runRecallMeasurementLauncher } from "../../../runs/recall-measurement/launch.js";

afterAll(() => isolation.restore());

it("preserves disabled source preparation and refuses native field scoring before reading labels", async () => {
  const root = mkdtempSync(join(tmpdir(), "source-only-replay-"));
  const text = "The blue stone is kept in the cedar box.";
  try {
    const snapshot = await prepareNativeSourceRecordsSnapshot({ snapshotPath: join(root, "input.sqlite"),
      dataDirRoot: join(root, "publication"), workspaceId: "stone-library", runId: "stone-library-run",
      producerCommit: "22650b55c4c0e2814b115918ad979a1c0d0dbad6", sources: [{
        source_id: "stone-note", source_version: "1", title: "Stone note", content_bytes: text,
        source_observed_at: "2026-09-21T00:00:00.000Z", recorded_at: "2026-09-21T00:00:00.000Z"
      }] });
    const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot.snapshot_path, snapshot_sha256: snapshot.db_sha256,
      implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-22T00:00:00.000Z",
      workspace_id: snapshot.workspace_id, run_id: snapshot.run_id,
      query_workset: parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
        model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1", provider_url: "http://127.0.0.1:9",
        items: [{ original_query: "What color is the stone?" }] }),
      query_cache_root: join(root, "unattempted-query-cache"), correspondence_cache_root: join(root, "unattempted-correspondence-cache"),
      max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 0,
      access_policy: "query-conditioned-v1", authorized_scopes: { mode: "named", scopes: ["project"] },
      budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 60_000_000,
        page_budget: 10_000, finalization_reserve: 50_000, min_envelope: 10 }, output_byte_limit: 1_000_000 });
    expect(config.source_index).toBeUndefined();
    const chainRoot = join(root, "chain");
    const plan = await prepareSemanticChain(config, chainRoot);
    const query = plan.queries[0]!;
    expect(query.status).toBe("raw_ready");
    if (query.status === "blocked") throw new Error("Disabled Source preparation was blocked");
    const preparation = sourceSemanticAccessPhases(query.discovery_trace[0]!.access).preparation;
    expect(preparation).toMatchObject({ status: "unavailable", reason: "source_index_unknown", method: "not_run",
      submitted_inputs: 0, external_api_attempts: 0 });
    const replay = await replaySemanticChain(chainRoot);
    const row = ReplaySchema.parse(replay.result).rows[0]!;
    expect(row.status).toBe("replayed");
    // Native field pages cannot acquire an archived source-gold exposure credential.
    // Historical accepted delivery remains covered by private-library-archive.test.ts.
    expect(row.first_exposure).toBeNull();
    expect(row.response).toMatchObject({ operation: "recall", protocol_version: 11 });
    if (row.response?.operation !== "recall") throw new Error("Disabled replay did not return native recall");
    expect(row.response.proofs ?? []).toEqual([]);
    const replayPreparation = sourceSemanticAccessPhases(row.preparation_trace![0]!.access).preparation;
    expect(replayPreparation).toMatchObject({ status: "unavailable", method: "not_run", submitted_inputs: 0, external_api_attempts: 0 });
    const labels = vi.fn(() => { throw new Error("unsupported delivery must not read labels"); });
    const measured = measureSemanticChain(chainRoot, replay.path, labels, join(root, "evaluator"));
    const refusal = { status: "replayed", reason: "invalid_response",
      measurement: { schema_version: 1, status: "invalid", reason: "invalid_response" }, source_bearing_union: null };
    expect(measured.result.rows[0]).toMatchObject(refusal);
    expect(labels).not.toHaveBeenCalled();
    expect(measured.result.gold).toEqual([{ query_key: query.query_key, source_units: null }]);
    const goldPath = join(root, "gold.json");
    writeFileSync(goldPath, "not valid gold JSON");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await runRecallMeasurementLauncher(["measure", "--root", chainRoot, "--replay", replay.path,
        "--gold", goldPath, "--evaluator-root", join(root, "cli-evaluator")])).toBe(0);
      const result = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).result;
      expect(result.rows[0]).toMatchObject(refusal);
      expect(result.gold).toEqual([{ query_key: query.query_key, source_units: null }]);
    } finally { stdout.mockRestore(); }
    assertChainSnapshot(config);
    expect(isolation.violations).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
