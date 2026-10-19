import { afterAll, expect, it, vi } from "vitest";

type GuardReport = { phase: string; pid: number; preload_specifier: string; exec_argv?: string[];
  configured_child_exec_argv?: string[]; credential_environment_count: number; transport_guards: string[];
  violations: string[]; local_responses: number; observed_application_replies?: number };
type Isolation = { children: { pid: number; preload: string; exited: boolean; code: number | null; signal: string | null }[];
  childReports: GuardReport[]; requests: { op: string; inputs: number }[];
  readOnlyGitCalls: { command: string; args: string[]; credential_environment_count: number }[];
  snapshot(): GuardReport; restore(): void; writeReceipts(reason: string): void; close(): Promise<void> };
const offline = await vi.hoisted(async () => {
  const cache = process.env.ALAYA_LOCAL_SOURCE_EMBEDDING_CACHE_DIR;
  if (process.env.ALAYA_LOCAL_SOURCE_EMBEDDING_OFFLINE !== "1" || !cache) {
    console.info("[cached-local-source-chain] SKIPPED: explicit offline inference/cache opt-in required");
    return { cache, isolation: null as Isolation | null, receiptDir: null as string | null };
  }
  // Reuse both owners: pre-import CLI credential/loopback protection and explicit native-child isolation.
  const bootstrap = new URL("../../support/provider-free-cli-bootstrap.mjs", import.meta.url).href;
  await import(/* @vite-ignore */ bootstrap);
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  // Fresh receipt dir is opt-in and must stay outside the fixture temp tree.
  const receiptDir = mkdtempSync(join(tmpdir(), "cached-local-source-chain-guard-receipt-"));
  process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_ALLOW_GIT = "1";
  process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_INPUT_CAP = "3";
  process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_GUARD_RECEIPT_DIR = receiptDir;
  const preload = new URL("../../../../../../packages/core/src/__tests__/embedding-recall/local-onnx-source-embedding-offline-preload.mjs", import.meta.url).href;
  const { isolation } = await import(/* @vite-ignore */ preload);
  return { cache, isolation: isolation as Isolation, receiptDir };
});
afterAll(async () => { await offline.isolation?.close(); });

it.skipIf(offline.isolation === null)("activates, seals, prepares and delivers one Source with the shared guarded local child", {
  timeout: 240_000, retry: 0
}, async () => {
  // Application imports must remain after the pre-import guards, including the normal daemon launcher.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { prepareNativeSourceRecordsSnapshot } = await import("../../../runs/snapshot/source-records/native.js");
  const { readCurrentExtractionAuthorityRevision } = await import("../../../runs/extraction/authority/inspection.js");
  const { parseSemanticProposalWorkset } = await import("../../../runs/semantic-cache/workset.js");
  const { SemanticChainConfigSchema, assertChainSnapshot, withSemanticChainDaemon,
    writeChainArtifact } = await import("../../../runs/recall-measurement/contract.js");
  const { prepareSemanticChainSourceIndex, inspectSemanticChainSourceIndex } = await import("../../../runs/recall-measurement/source-index-binding.js");
  const { prepareSemanticChain, discoverSemanticChainQuery } = await import("../../../runs/recall-measurement/prepare.js");
  const { inspectSemanticChainReplayTarget, deliverPreparedSemanticChainQuery,
    closeSemanticChainReplayFromDurableRows, measureSemanticChain } = await import("../../../runs/recall-measurement/replay.js");
  const { sourceSemanticAccessPhases } = await import("@do-soul/alaya-protocol");
  const root = mkdtempSync(join(tmpdir(), "cached-local-source-chain-"));
  const isolation = offline.isolation!;
  const text = "The blue stone is kept in the cedar box.";
  const queryText = "What color is the stone?";
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
  expect(offline.receiptDir).not.toBeNull();
  expect(offline.receiptDir!.startsWith(root)).toBe(false);
  let outcome = "failure";
  try {
    const snapshot = await prepareNativeSourceRecordsSnapshot({ snapshotPath: join(root, "input.sqlite"),
      dataDirRoot: join(root, "source-publication"), workspaceId: "stone-library", runId: "stone-library-run",
      producerCommit: "22650b55c4c0e2814b115918ad979a1c0d0dbad6", sources: [{
        source_id: "stone-note", source_version: "1", title: "Stone note", content_bytes: text,
        source_observed_at: "2026-09-21T00:00:00.000Z", recorded_at: "2026-09-21T00:00:00.000Z"
      }] });
    const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot.snapshot_path, snapshot_sha256: snapshot.db_sha256,
      implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-22T00:00:00.000Z",
      workspace_id: snapshot.workspace_id, run_id: snapshot.run_id,
      query_workset: parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
        model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1", provider_url: "http://127.0.0.1:9",
        items: [{ original_query: queryText }] }),
      query_cache_root: join(root, "unattempted-query-cache"), correspondence_cache_root: join(root, "unattempted-correspondence-cache"),
      max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 0,
      access_policy: "query-conditioned-v1", authorized_scopes: { mode: "named", scopes: ["project"] },
      budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 60_000_000,
        page_budget: 10_000, finalization_reserve: 50_000, min_envelope: 10 }, output_byte_limit: 1_000_000 });
    await withSemanticChainDaemon(config, join(root, "disabled"), async daemon => {
      const disabled = await discoverSemanticChainQuery(daemon, config, queryText);
      const phases = sourceSemanticAccessPhases(disabled.discovery.discovery_trace[0]!.access);
      expect(phases.preparation).toMatchObject({ status: "unavailable", method: "not_run", submitted_inputs: 0 });
      expect(isolation.children).toHaveLength(0);
    });
    const chainRoot = join(root, "chain");
    let measured = false;
    const result = await prepareSemanticChainSourceIndex(config, {
      cache_root: offline.cache, model_id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
    }, join(root, "enabled-setup"), async (enabled, daemon) => {
      const binding = enabled.source_index!.index;
      expect(binding).toMatchObject({ status: "ready", enumeration_complete: true, target_count: 1, completed_count: 1 });
      expect(binding.configuration.profile).toMatchObject({ provider_kind: "local_onnx", dimensions: 384,
        max_input_tokens: 512, window_bytes: 504, windowing: "utf8-byte-windows.v1" });
      expect(binding.configuration.profile.artifact_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(inspectSemanticChainSourceIndex(enabled.snapshot_path, enabled.workspace_id).index).toEqual(binding);
      const plan = await prepareSemanticChain(enabled, chainRoot, daemon);
      const query = plan.queries[0]!;
      expect(query.status).toBe("raw_ready");
      if (query.status === "blocked") throw new Error("Authored Source discovery was blocked");
      const phases = sourceSemanticAccessPhases(query.discovery_trace[0]!.access);
      expect(phases.preparation).toMatchObject({ status: "ready", method: "local_inference", submitted_inputs: 1,
        external_api_attempts: 0, selected: { profile_id: binding.profile_id, config_id: binding.config_id,
          selection_revision: binding.selection_revision, profile: binding.configuration.profile } });
      expect(phases.acquisition.result?.vector).toMatchObject({ input: { status: "available", profile_id: binding.profile_id },
        state: { status: "ready", binding: { generation_id: binding.generation_id, source_epoch: binding.source_epoch } },
        inspected_windows: 1 });
      expect(phases.acquisition.result?.nominations.some(row => row.vector !== null)).toBe(true);
      const prepared = await discoverSemanticChainQuery(daemon, enabled, queryText);
      const replay = inspectSemanticChainReplayTarget(chainRoot, "retained");
      const rowPath = replay.rowPaths.get(query.query_key)!;
      writeChainArtifact(`${rowPath}.reserved`, { replay_identity: replay.identity, query_key: query.query_key });
      const row = await deliverPreparedSemanticChainQuery({ daemon, config: enabled, query, prepared, ready: [], outcomes: [],
        rowPath, replayIdentity: replay.identity, preparationElapsed: 0, preparationError: null, started: performance.now() });
      expect(row.status).toBe("replayed");
      expect("response" in row && row.response.operation === "recall" && row.response.results?.some(item => item.content_preview === text)).toBe(true);
      const closed = await closeSemanticChainReplayFromDurableRows(chainRoot);
      expect(closed).not.toBeNull();
      const measurement = measureSemanticChain(chainRoot, closed!.path, [{ query_key: query.query_key, source_units: [] }], join(root, "evaluator"));
      expect(measurement.result.rows[0]?.status).toBe("replayed");
      expect(measurement.result.rows[0]?.measurement?.status).toBe("validated");
      expect(isolation.requests.every(request => ["warmup", "bind_source", "embed_source"].includes(request.op))).toBe(true);
      measured = true;
      assertChainSnapshot(enabled);
    });
    expect(result.config).not.toBeNull();
    expect(measured).toBe(true);
    expect(result.report.setup).toMatchObject({ status: "settled", binding: { status: "ready" },
      resources: { model_inputs: 1, input_bytes: Buffer.byteLength(text) }, accounting: "lower_bound",
      warmup: "not_separately_measured", model_execution_work: "unknown" });
    if (result.config === null) throw new Error("Actual local producer did not activate");
    assertChainSnapshot(result.config); // Reopens SQLite after the owning daemon and child have exited.
    expect(isolation.requests.filter(request => request.op === "embed_source").reduce((sum, request) => sum + request.inputs, 0)).toBe(3);
    expect(isolation.requests.filter(request => request.op === "warmup")).toHaveLength(1);
    expect(isolation.children).toHaveLength(1);
    expect(isolation.children[0]!.exited).toBe(true);
    expect(isolation.childReports.some(report => report.phase === "installed")).toBe(true);
    expect(isolation.childReports[0]?.phase).toBe("installed");
    const parent = isolation.snapshot();
    expect(parent.preload_specifier).toBe(isolation.children[0]!.preload);
    expect(parent.configured_child_exec_argv).toEqual(["--import", isolation.children[0]!.preload]);
    for (const report of isolation.childReports) {
      const argv = report.exec_argv ?? [];
      expect(report.pid).toBe(isolation.children[0]!.pid);
      expect(report.preload_specifier).toBe(isolation.children[0]!.preload);
      expect(argv.includes("--import")).toBe(true);
      expect(argv[argv.indexOf("--import") + 1]).toBe(report.preload_specifier);
      expect(report.credential_environment_count).toBe(0);
      expect(report.violations).toEqual([]);
    }
    expect(parent.violations).toEqual([]);
    console.info("[cached-local-source-chain] receipt", JSON.stringify({ setup: result.report,
      parent_guard: isolation.snapshot(), children: isolation.children, child_checkpoints: isolation.childReports,
      submitted_inputs: isolation.requests, read_only_git: isolation.readOnlyGitCalls,
      inference_input_limit: 3, warmup: "not_separately_measured",
      guard_receipt_dir: offline.receiptDir }));
    outcome = "success";
  } finally {
    isolation.writeReceipts(outcome);
    rmSync(root, { recursive: true, force: true });
  }
});
