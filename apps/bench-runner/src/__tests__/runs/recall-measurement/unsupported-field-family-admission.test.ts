import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORDINARY_NATIVE_FIELD_RESULT_VERSION, SoulInterpretationFieldRecallDeliverySchema,
  SoulInterpretationResponseSchema
} from "@do-soul/alaya-protocol";
import { fieldLibraryPage } from "./field-library.test-support.js";
import { FirstExposurePageSchema } from "../../../runs/measurement/first-exposure-session.js";
import * as sourceGoldJoin from "../../../runs/measurement/source-gold-join.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import { prepareNativeSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-cache/workset.js";
import { prepareSemanticChain } from "../../../runs/recall-measurement/prepare.js";
import { inspectSemanticChainReplayTarget, measureSemanticChain } from "../../../runs/recall-measurement/replay.js";
import { admitSemanticChainLibraryCapture } from "../../../runs/recall-measurement/library-capture.js";
import { semanticChainLibraryRecallRequest, admitSemanticChainLibraryBinding } from "../../../runs/recall-measurement/library-admission.js";
import { SemanticChainConfigSchema, chainIdentity, readChainArtifact, writeChainArtifact } from "../../../runs/recall-measurement/contract.js";
import { measureLongMemEvalAcquisition, summarizeLongMemEvalAcquisition } from "../../../runs/longmemeval-semantic/acquisition-measurement.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); isolation.restore(); });

const SOURCE_TEXT = "The blue stone is kept in the cedar box.";
const DIGEST = `sha256:${"c".repeat(64)}`;

/** Real sealed SQLite snapshot plus a frozen chain root whose recorded page is the live field family.
 * `firstExposure` states whether the recording captured exposure: a refusal must not depend on it. */
async function fixture(options: Readonly<{ firstExposure?: "present" | "absent"; response?: "delivered" | "missing" }> = {}) {
  const root = mkdtempSync(join(tmpdir(), "unsupported-field-family-"));
  roots.push(root);
  const snapshot = await prepareNativeSourceRecordsSnapshot({ snapshotPath: join(root, "input.sqlite"),
    dataDirRoot: join(root, "publication"), workspaceId: "field-family", runId: "field-family-run",
    producerCommit: "22650b55c4c0e2814b115918ad979a1c0d0dbad6", sources: [{ source_id: "stone-note",
      source_version: "1", title: "Stone note", content_bytes: SOURCE_TEXT,
      source_observed_at: "2026-09-21T00:00:00.000Z", recorded_at: "2026-09-21T00:00:00.000Z" }] });
  const config = SemanticChainConfigSchema.parse({ snapshot_path: snapshot.snapshot_path,
    snapshot_sha256: snapshot.db_sha256, implementation_revision: readCurrentExtractionAuthorityRevision(),
    interpretation_clock: "2026-09-22T00:00:00.000Z", workspace_id: snapshot.workspace_id, run_id: snapshot.run_id,
    query_workset: parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
      model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1", provider_url: "http://127.0.0.1:9",
      items: [{ original_query: "Where is the blue stone?" }] }),
    query_cache_root: join(root, "unattempted-query-cache"),
    correspondence_cache_root: join(root, "unattempted-correspondence-cache"),
    max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 0,
    access_policy: "query-conditioned-v1", authorized_scopes: { mode: "named", scopes: ["project"] },
    budget: { schema_version: 1, work_units: 10_000_000, memory_bytes: 60_000_000,
      page_budget: 10_000, finalization_reserve: 50_000, min_envelope: 10 }, output_byte_limit: 1_000_000 });
  const chainRoot = join(root, "chain");
  const plan = await prepareSemanticChain(config, chainRoot);
  const query = plan.queries[0]!;
  if (query.status === "blocked") throw new Error("fixture query was blocked");
  const target = inspectSemanticChainReplayTarget(chainRoot, "retained");
  const rowPath = target.rowPaths.get(query.query_key)!;
  const page = fieldLibraryPage(snapshot.sources[0]!.record, config.budget, config.interpretation_clock, SOURCE_TEXT);
  const exposure = options.firstExposure === "absent" ? null
    : FirstExposurePageSchema.parse(recordSourceSemanticLibraryFirstExposure(page));
  const row = { query_key: query.query_key, status: "replayed" as const,
    ...(options.response === "missing" ? {} : { response: page }),
    first_exposure: exposure, correspondence_outcomes: [], preparation_trace: query.discovery_trace };
  writeChainArtifact(target.output, { contract: "source-semantic-chain-replay-v3", plan_identity: chainIdentity(plan),
    identity: target.identity, arm: "retained", provider_calls: 0, rows: [row] });
  writeChainArtifact(rowPath, row);
  writeChainArtifact(`${rowPath}.reserved`, { replay_identity: target.identity, query_key: query.query_key });
  // The cursor a producer returns on this page, kept for the live ingress round trip.
  const cursor = SoulInterpretationFieldRecallDeliverySchema.parse({ ...page,
    index: { ...page.index, continuation: { schema_version: 1, continuation_id: "field-page-2",
      query_id: page.index.query_id, snapshot_id: DIGEST, result_version: ORDINARY_NATIVE_FIELD_RESULT_VERSION,
      expires_at: "2099-01-01T00:00:00.000Z", cursor: "offset-1", enumeration_policy: "native_query" } } })
    .index!.continuation!;
  return { root, chainRoot, plan, config, query, page, exposure, cursor, replayPath: target.output,
    captureRoot: join(root, "capture"), gold: [{ query_key: query.query_key, source_units: [] }] };
}

/** Frozen capture-owner directory for the same recorded field page; no daemon and no label input. */
function captureRoot(f: Awaited<ReturnType<typeof fixture>>) {
  const request = { name: "soul.interpretation", arguments: semanticChainLibraryRecallRequest(
    f.config, f.query, [], "field-query-handle") as Record<string, unknown> };
  const material = { contract: "source-semantic-library-capture-v1", mode: "library" as const, max_pages: 1 as const,
    execution_observation: "disabled" as const, output_root: f.captureRoot,
    plan_identity: chainIdentity(f.plan), correspondence_identity: inspectSemanticChainReplayTarget(
      f.chainRoot, "retained").identity, arm: "retained" as const };
  const identity = chainIdentity(material);
  writeChainArtifact(join(f.captureRoot, "capture-owner.json"), { ...material, identity });
  writeChainArtifact(join(f.captureRoot, "capture.json"), { contract: "source-semantic-library-capture-v1",
    identity, query_keys: [f.query.query_key] });
  const directory = join(f.captureRoot, f.query.query_key);
  writeChainArtifact(join(directory, "stop.json"), { status: "captured", reason: "requested_page_bound", page2: "not_requested" });
  writeChainArtifact(join(directory, "initial.json"), { query_key: f.query.query_key, status: "replayed",
    response: f.page, first_exposure: f.exposure, correspondence_outcomes: [], preparation_trace: f.query.discovery_trace });
  writeChainArtifact(join(directory, "initial.json.reserved"), { replay_identity: identity, query_key: f.query.query_key });
  writeChainArtifact(join(directory, "page-1.request.json"), request);
  writeChainArtifact(join(directory, "page-1.reserved"), { capture_identity: identity, query_key: f.query.query_key,
    page: 1, request_identity: chainIdentity(request) });
  writeChainArtifact(join(directory, "page-1.mcp.json"), { request,
    response: { content: [{ type: "text", text: JSON.stringify({ ok: true, tool_name: "soul.interpretation", output: f.page }) }],
      structuredContent: { ok: true, output: f.page } } });
  return f.captureRoot;
}

it("keeps the refused field family replayed and explicitly invalid through replay measurement", async () => {
  const f = await fixture();
  const scoring = vi.spyOn(sourceGoldJoin, "scoreSourceBearingUnionFirstExposure");
  const proofScoring = vi.spyOn(sourceGoldJoin, "scoreProofConditionedFirstExposure");
  try {
    const labels = vi.fn(() => { throw new Error("refused delivery cannot read labels"); });
    const measured = measureSemanticChain(f.chainRoot, f.replayPath, labels, join(f.root, "evaluator"));
    expect(labels).not.toHaveBeenCalled();
    const row = measured.result.rows[0]!;
    expect(row.status).toBe("replayed");
    expect(row.reason).toBe("invalid_response");
    expect(row.mechanism.reason).toBe("invalid_response");
    expect(row.measurement).toEqual({ schema_version: 1, status: "invalid", reason: "invalid_response" });
    expect(row.source_bearing_union).toBeNull();
    expect(row.mechanism.validated_proof_ranks).toEqual([]);
    // No proof slot, label or source interval was read for the refused family.
    expect(row.evaluator_usage).toEqual({ proof_slots_checked: 0, work_units: 0, logical_memory_bytes: 0 });
    expect(scoring).not.toHaveBeenCalled();
    expect(proofScoring).not.toHaveBeenCalled();
    expect(JSON.stringify(measured.result)).not.toContain("another frozen request");
    expect(JSON.stringify(measured.result)).not.toContain("native_unavailable");
  } finally { scoring.mockRestore(); proofScoring.mockRestore(); }
}, 120_000);

it("records a refused field page in capture admission without archived source binding", async () => {
  const f = await fixture();
  const admitted = admitSemanticChainLibraryCapture(f.chainRoot, captureRoot(f));
  const row = admitted.rows[0]!;
  expect(row.status).toBe("partial");
  expect(row.pages).toEqual([expect.objectContaining({ page: 1, status: "unobserved",
    reason: "unsupported_library_family", occupied_slots: 0, complete: false, continuation: "unknown", intervals: [] })]);
  expect(row.source_records).toEqual([]);
  expect(row.execution_observation).toEqual({ status: "unobserved", observations: null });
}, 120_000);

/** The known family decision precedes every evidence prerequisite: exposure, gold and proof.
 * An unsupported response must be refused on what it is, not become an unobserved delivery. */
it("keeps the same family refusal when the recorded first exposure is absent", async () => {
  const f = await fixture({ firstExposure: "absent" });
  const measured = measureSemanticChain(f.chainRoot, f.replayPath, f.gold, join(f.root, "evaluator"));
  const row = measured.result.rows[0]!;
  expect(row.status).toBe("replayed");
  expect(row.measurement).toEqual({ schema_version: 1, status: "invalid", reason: "invalid_response" });
  expect(row.source_bearing_union).toBeNull();
  expect(row.evaluator_usage).toEqual({ proof_slots_checked: 0, work_units: 0, logical_memory_bytes: 0 });
  expect(row.mechanism.reason).not.toBe("no_validated_delivered_proof");
  expect(JSON.stringify(measured.result)).not.toContain("native_unavailable");
  const captured = admitSemanticChainLibraryCapture(f.chainRoot, captureRoot(f)).rows[0]!;
  expect(captured.pages).toEqual([expect.objectContaining({ page: 1, status: "unobserved",
    reason: "unsupported_library_family" })]);
  expect(captured.source_records).toEqual([]);
}, 120_000);

/** A genuinely absent delivery keeps its own distinct cause; it is not a refused family. */
it("keeps a missing recorded delivery distinct from the family refusal", async () => {
  const f = await fixture({ firstExposure: "absent", response: "missing" });
  const measured = measureSemanticChain(f.chainRoot, f.replayPath, f.gold, join(f.root, "evaluator"));
  expect(measured.result.rows[0]).toMatchObject({ status: "native_unavailable", measurement: null });
  expect(measured.result.rows[0]!.reason).toMatch(/native initial delivery/u);
  expect(JSON.stringify(measured.result)).not.toContain("invalid_response");
}, 120_000);

/** The gate precedes the archived binding; it does not replace or soften that identity rule. */
it("keeps archived library identity binding closed to a field page", async () => {
  const f = await fixture();
  expect(() => admitSemanticChainLibraryBinding(f.config, f.query, f.page, [], f.query.discovery_trace))
    .toThrow(/another frozen request/u);
}, 120_000);

/** Downstream acquisition/report consumers of the same measurement row. The known refusal stays
 * explicit through metrics, aggregate counts and loss attribution, for both exposure states. */
it.each(["present", "absent"] as const)("carries the family refusal into acquisition and report aggregation (exposure %s)",
  async (firstExposure) => {
    const f = await fixture({ firstExposure });
    const measured = measureSemanticChain(f.chainRoot, f.replayPath, f.gold, join(f.root, "evaluator"));
    const row = measured.result.rows[0]!;
    const replayRow = { query_key: f.query.query_key, status: "replayed" as const, response: f.page, first_exposure: f.exposure };
    const acquisition = measureLongMemEvalAcquisition({ cohort: "answerable",
      sourceGold: { sourceUnits: [], complete: true }, native: row, replay: replayRow });
    const expected = { status: "unknown", reason: "invalid_response" };
    for (const name of ["source_bearing_any@5", "source_bearing_any@10", "answer_span_exposure@5",
      "answer_span_exposure@10", "answer_complete_coverage@5", "answer_complete_coverage@10"] as const) {
      expect(acquisition.metrics[name]).toEqual(expected);
    }
    // A refusal is a delivery fact, not an unobserved page chain or a supported empty page.
    expect(acquisition.delivery).toEqual({ unit: "roots_in_native_delivery_order",
      observed_pages: 0, observed_roots: null, continuation: "unknown" });
    expect(acquisition.earliest_observable_loss).toEqual({ status: "unknown", stage: null,
      earliest_unknown_stage: "source_available", observed_failed_stage: null });
    expect(acquisition.stages.filter(stage => stage.stage !== "consumer_use")
      .every(stage => stage.status === "unknown" && stage.reason === "invalid_response")).toBe(true);
    // Ordinary unavailability keeps its own distinct cause beside the known refusal.
    const summary = summarizeLongMemEvalAcquisition([acquisition,
      measureLongMemEvalAcquisition({ cohort: "answerable" })]);
    expect(summary.metrics["source_bearing_any@5"]).toEqual({ denominator: 2, hits: 0, misses: 0,
      unknown: 2, lower_bound: 0, upper_bound: 1 });
    expect(summary.unknown_reasons).toEqual([{ reason: "invalid_response", rows: 1 },
      { reason: "native_delivery_unavailable", rows: 1 }]);
    expect(summary.loss_attribution).toEqual({ denominator: 2, stages: { source_available: 0,
      candidate_pool: 0, deliverable_window: 0, admission: 0, delivery: 0, consumer_use: 0 },
      unknown: 2, no_observed_loss: 0 });
  }, 120_000);

/** The same fixtures through the compiled consumer modules, not only the tsconfig view. */
function compiledConsumerChain(f: Awaited<ReturnType<typeof fixture>>, evaluatorRoot: string) {
  const boundary = new URL("../../support/provider-free-boundary.ts", import.meta.url).href;
  const compiled = (name: string) => new URL(`../../../../dist/runs/recall-measurement/${name}`, import.meta.url).href;
  const protocol = new URL("../../../../../../packages/protocol/dist/index.js", import.meta.url).href;
  const budget = { schema_version: 1, work_units: 100, memory_bytes: 100_000, page_budget: 1,
    finalization_reserve: 10, min_envelope: 1 };
  const archived = { ...f.cursor as Record<string, unknown>, continuation_id: "page-5",
    result_version: "source-semantic-library-v6", enumeration_policy: undefined };
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", `
    const { installProviderFreeBoundary } = await import(${JSON.stringify(boundary)});
    const isolation = installProviderFreeBoundary();
    const replay = await import(${JSON.stringify(compiled("replay.js"))});
    const capture = await import(${JSON.stringify(compiled("library-capture.js"))});
    const protocol = await import(${JSON.stringify(protocol)});
    const { readFileSync } = await import("node:fs");
    const archived = JSON.parse(readFileSync(${JSON.stringify(f.replayPath)}, "utf8")).payload;
    if ((archived.rows[0].first_exposure === null) !== ${JSON.stringify(f.exposure === null)}) throw new Error("serialized exposure differs");
    const measured = replay.measureSemanticChain(${JSON.stringify(f.chainRoot)}, ${JSON.stringify(f.replayPath)},
      () => { throw new Error("refused delivery label read"); }, ${JSON.stringify(evaluatorRoot)});
    const admitted = capture.admitSemanticChainLibraryCapture(${JSON.stringify(f.chainRoot)}, ${JSON.stringify(f.captureRoot)});
    const launcher = await import(${JSON.stringify(compiled("launch.js"))});
    const cli = await launcher.runRecallMeasurementLauncher(["measure", "--root", ${JSON.stringify(f.chainRoot)},
      "--replay", ${JSON.stringify(f.replayPath)}, "--gold", ${JSON.stringify(join(f.root, "labels-must-not-be-read.json"))},
      "--evaluator-root", ${JSON.stringify(`${evaluatorRoot}-cli`)}]);
    const shared = { accepts_unreviewed_conditional_results: true, query_handle: "query-handle",
      budget: ${JSON.stringify(budget)}, output_byte_limit: 4096 };
    const publicIngress = protocol.SoulInterpretationRequestSchema.safeParse({ operation: "recall", ...shared,
      continuation: ${JSON.stringify(f.cursor)} });
    const workerIngress = protocol.SourceSemanticWorkerRequestSchema.safeParse({ kind: "recall", ...shared,
      continuation: ${JSON.stringify(f.cursor)} });
    const archivedIngress = protocol.SoulInterpretationRequestSchema.safeParse({ operation: "recall", ...shared,
      continuation: ${JSON.stringify(archived)} });
    if (isolation.violations.length !== 0) throw new Error("provider-free violations");
    console.log(JSON.stringify({ cli, row: measured.result.rows[0], capture: admitted.rows[0],
      ingress: { public: publicIngress.success, worker: workerIngress.success, archived: archivedIngress.success } }));
  `], { env, encoding: "utf8", timeout: 120_000 });
}

it.each(["present", "absent"] as const)("binds the refusal in compiled replay and capture with exposure %s", async firstExposure => {
  const f = await fixture({ firstExposure });
  const archived = readChainArtifact(f.replayPath) as { rows: { first_exposure: unknown }[] };
  expect(archived.rows[0]!.first_exposure === null).toBe(firstExposure === "absent");
  captureRoot(f);
  const result = compiledConsumerChain(f, join(f.root, "compiled-evaluator"));
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
    cli: number; row: { status: string; reason: string | null; measurement: unknown; source_bearing_union: unknown };
    capture: { status: string; pages: readonly { status: string; reason: string | null }[] };
    ingress: { public: boolean; worker: boolean; archived: boolean };
  };
  expect(output.cli).toBe(0);
  expect(output.row).toMatchObject({ status: "replayed", reason: "invalid_response",
    measurement: { schema_version: 1, status: "invalid", reason: "invalid_response" }, source_bearing_union: null });
  expect(output.capture.status).toBe("partial");
  expect(output.capture.pages).toEqual([expect.objectContaining({ status: "unobserved",
    reason: "unsupported_library_family" })]);
  // The returned cursor crosses both compiled live ingress schemas; the archived cursor does not.
  expect(output.ingress).toEqual({ public: true, worker: true, archived: false });
  expect(isolation.violations).toEqual([]);
}, 180_000);
