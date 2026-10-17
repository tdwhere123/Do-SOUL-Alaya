import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalOnnxEmbeddingClient, deriveAddressableSpanViews, fieldContractSha256 } from "@do-soul/alaya-core";
import { SoulInterpretationResponseSchema, sourceIndexProfileId, sourceSemanticAccessPhases,
  packSourceSemanticQueryPreparation, packSourceSemanticAcquisition, sourceSemanticAcquisitionNotRun,
  type SourceSemanticQueryPreparation, type SourceSemanticAcquisitionPhase } from "@do-soul/alaya-protocol";
import { prepareNativeSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { SemanticChainConfigSchema, withSemanticChainDaemon } from "../../../runs/semantic-chain/contract.js";
import { prepareSemanticChainSourceIndex } from "../../../runs/semantic-chain/source-index-binding.js";
import { assertSemanticChainSourceObservation, SemanticChainSourceObservationError } from "../../../runs/semantic-chain/source-index-observation.js";
import { prepareSemanticChain, discoverSemanticChainQuery } from "../../../runs/semantic-chain/prepare.js";
import { replaySemanticChain, ReplaySchema } from "../../../runs/semantic-chain/replay.js";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { configuration } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";

afterAll(() => isolation.restore());

it("admits a matching restored daemon and distinguishes native failures from uncaptured execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "source-observation-"));
  const fork = vi.spyOn(childProcess, "fork").mockImplementation(() => { throw new Error("Native inference is forbidden in this fixture"); });
  syncBuiltinESMExports();
  // Daemon startup probes embedTexts directly; warmup is not its provider entry.
  vi.spyOn(LocalOnnxEmbeddingClient.prototype, "embedTexts").mockImplementation(async texts =>
    texts.map(() => new Float32Array([0.6, 0.8, 0])));
  let unsupported = false;
  vi.spyOn(LocalOnnxEmbeddingClient.prototype, "bindSourceEmbedding").mockImplementation(async options => {
    if (unsupported) return { status: "unsupported", reason: "fixture_runtime_unsupported" };
    // Only the provider is a deterministic fixture: daemon, MCP, worker, producer, SQLite and restore are real.
    const profile = configuration({ provider_kind: "local_onnx", model_id: "fixture-local-model", max_input_tokens: 512,
      window_bytes: options.window_bytes }).profile;
    return { status: "ready", profile, profile_id: sourceIndexProfileId(profile, fieldContractSha256),
      embedInputs: async inputs => inputs.map(input => ({ status: "embedded", input_id: input.input_id,
        input_digest: `sha256:${fieldContractSha256(input.text)}`, token_count: 4, truncated: false,
        vector: new Float32Array([0.6, 0.8, 0]) })) };
  });
  try {
    const snapshot = await prepareNativeSourceRecordsSnapshot({ snapshotPath: join(root, "input.sqlite"),
      dataDirRoot: join(root, "publication"), workspaceId: "stone-library", runId: "stone-run",
      producerCommit: "22650b55c4c0e2814b115918ad979a1c0d0dbad6", sources: [{ source_id: "stone-note", source_version: "1",
        title: "Stone note", content_bytes: "A blue stone.", source_observed_at: "2026-09-21T00:00:00.000Z", recorded_at: "2026-09-21T00:00:00.000Z" }] });
    const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot.snapshot_path, snapshot_sha256: snapshot.db_sha256,
      implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-22T00:00:00.000Z",
      workspace_id: snapshot.workspace_id, run_id: snapshot.run_id,
      query_workset: parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
        model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1", provider_url: "http://127.0.0.1:9",
        items: [{ original_query: "What color is the stone?" }] }),
      query_cache_root: join(root, "q-cache"), correspondence_cache_root: join(root, "c-cache"),
      max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 0, access_policy: "query-conditioned-v1",
      authorized_scopes: { mode: "named", scopes: ["project"] }, output_byte_limit: 1_000_000,
      budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 60_000_000,
        page_budget: 10_000, finalization_reserve: 50_000, min_envelope: 10 } });
    const setup = await prepareSemanticChainSourceIndex(config, { cache_root: join(root, "fixture-cache"), model_id: "fixture-local-model" }, join(root, "setup"));
    if (setup.config === null) throw new Error("Fixture Source index did not activate");
    const enabled = setup.config, chainRoot = join(root, "matching-chain");
    await withSemanticChainDaemon(enabled, join(root, "restored"), async daemon => {
      const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation", {
        operation: "prepare_query", original_query: "What color is the stone?", budget: enabled.budget,
        authorized_scopes: enabled.authorized_scopes, access_policy: enabled.access_policy }));
      if (response.operation !== "prepare_query" || response.access === undefined) throw new Error("Actual preparation receipt missing");
      expect(() => assertSemanticChainSourceObservation(enabled, response)).not.toThrow();
      const phases = sourceSemanticAccessPhases(response.access);
      const acquired = phases.acquisition.result, vectorState = acquired?.vector.state;
      if (acquired == null || vectorState == null || !("binding" in vectorState)) throw new Error("Actual fixture binding missing");
      const altered = (preparation: SourceSemanticQueryPreparation, acquisition: SourceSemanticAcquisitionPhase) => ({ ...response,
        access: { ...response.access!, phases: [response.access!.phases[0], packSourceSemanticQueryPreparation(preparation),
          packSourceSemanticAcquisition(acquisition), response.access!.phases[3]] as const } });
      for (const invalid of [altered({ ...phases.preparation, selected: null }, phases.acquisition),
        altered(phases.preparation, sourceSemanticAcquisitionNotRun("fixture_missing_acquisition")),
        altered(phases.preparation, { ...phases.acquisition, result: { ...acquired,
          vector: { ...acquired.vector, state: { status: "partial", binding: vectorState.binding } } } }),
        altered(phases.preparation, { ...phases.acquisition, result: { ...acquired,
          vector: { ...acquired.vector, state: { status: "unavailable", reason: "fixture_binding_unavailable" } } } })]) {
        expect(() => assertSemanticChainSourceObservation(enabled, invalid)).toThrow(SemanticChainSourceObservationError);
      }
      const matching = await prepareSemanticChain(enabled, chainRoot, daemon);
      expect(matching.queries[0]?.status).toBe("raw_ready");
      await daemon.importSourceRecord({ source_id: "later-note", source_version: "1", content_bytes: "A green leaf.",
        recorded_at: "2026-09-21T01:00:00.000Z", event_time: null, valid_from: null, valid_to: null, scope_class: "project",
        spans: deriveAddressableSpanViews("A green leaf.") });
      await daemon.checkpointFieldProjection();
      await daemon.runtime.runSourceIndexPass!();
      const changed = await prepareSemanticChain(enabled, join(root, "changed-generation"), daemon);
      expect(changed.queries[0]).toMatchObject({ status: "blocked", discovery_failure: { kind: "mismatch", reason: "active_generation_changed",
        response: { operation: "prepare_query" } } });
      unsupported = true;
      await daemon.runtime.runSourceIndexPass!();
      const unavailable = await prepareSemanticChain(enabled, join(root, "unavailable"), daemon);
      expect(unavailable.queries[0]).toMatchObject({ status: "blocked", discovery_failure: { kind: "unavailable",
        response: { operation: "prepare_query" } } });
      const failure = unavailable.queries[0];
      if (failure?.status !== "blocked" || failure.discovery_failure?.response.operation !== "prepare_query") throw new Error("Actual failure receipt missing");
      expect(sourceSemanticAccessPhases(failure.discovery_failure.response.access!).preparation.selected).toBeNull();
      // Phase capture itself cannot fit: no native receipt exists to classify or retain.
      const uncaptured = await discoverSemanticChainQuery(daemon, { ...enabled, budget: { ...enabled.budget,
        work_units: 1, memory_bytes: 64, finalization_reserve: 0, page_budget: 0 } }, "What color is the stone?")
        .catch((error: unknown) => error);
      expect(uncaptured).toBeInstanceOf(Error);
      expect(uncaptured).toMatchObject({ message: expect.stringContaining("MCP tool soul.interpretation failed") });
      expect(uncaptured).not.toBeInstanceOf(SemanticChainSourceObservationError);
      expect(uncaptured).not.toHaveProperty("failure");
    });
    const replay = ReplaySchema.parse((await replaySemanticChain(chainRoot)).result);
    expect(replay.rows[0]).toMatchObject({ status: "native_unavailable", first_exposure: null,
      preparation_failure: { kind: "unavailable", reason: "fixture_runtime_unsupported", response: { operation: "prepare_query" } } });
    expect(fork).not.toHaveBeenCalled();
    expect(isolation.violations).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
