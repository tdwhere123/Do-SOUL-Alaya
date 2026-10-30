import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/strict-provider-free-boundary.js");
  const safe = installProviderFreeBoundary(), strict = installStrictProviderFreeBoundary();
  return { safe, strict };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); expect(isolation.safe.violations).toEqual([]); expect(isolation.strict.forbidden).toEqual([]); });
afterAll(() => { isolation.strict.restore(); isolation.safe.restore(); });

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, RuntimeGardenComputeConfigSchema, sourceSemanticQueryIdentity, type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { closeCachedDatabase, initDatabase, SqliteConfigRepo } from "@do-soul/alaya-storage";
import { fieldContractSha256, SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID, SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_VERSION,
  type SourceFeedbackCorrespondenceAction, type SourceFeedbackCorrespondenceHost, type SourceFeedbackCorrespondenceResult,
  type SourceFeedbackSessionInput } from "@do-soul/alaya-core";
import { buildSourceSemanticCorrespondenceRequest, proposeCorrespondenceSemantics } from "@do-soul/alaya-soul";
import { executeSourceFeedback } from "../../../runtime/recall/source-feedback-execution.js";
import type { SourceSemanticsExecutionPort } from "../../../runtime/recall/recall-read-worker-client.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { CHILD, CONTEXT, query, withFeedbackSource } from "./source-feedback.test-support.js";
import { assessmentForTestPairs } from "../../../../../bench-runner/src/__tests__/support/semantic-correspondence-assessment.js";

const ORIGINAL = "Which ticket does M7 use, and what clearance applies?";
const STRICT_BOOTSTRAP = new URL("../../../../../bench-runner/src/__tests__/support/strict-provider-free-cli-bootstrap.mjs", import.meta.url);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporaryDirectory() {
  const root = mkdtempSync(join(tmpdir(), "source-feedback-qualification-")); roots.push(root); return root;
}
function parentQuery(evidence = true): SourceSemanticQuery {
  const q = query(), use = q.alternatives[0]!;
  return { ...q, original_query_digest: `sha256:${fieldContractSha256(ORIGINAL)}`,
    variables: [...q.variables, { id: "approval", sort: "proposition" }],
    requested_operation: { reading: "identify ticket and clearance", support: { kind: "query_text", excerpt: ORIGINAL } },
    alternatives: [{ ...use,
      frames: [...use.frames, { id: "qApproval", variable: "approval", predicate_reading: "clearance",
        role_requirements: evidence ? [] : [{ id: "theme", role_reading: "theme", target_variable: "ticket",
          support: { kind: "query_text", excerpt: "ticket" } }] }],
      context_obligations: [...use.context_obligations, { frame: "qApproval", kind: "asserted_at_source" }],
      ...(evidence ? { answer_frames: [], evidence_inputs: [{ frames: ["qUse"] }, { frames: ["qApproval"] }] } : {}) }] };
}

/** Authored test host only: existing SOUL decoding and Core/native admission, no cache writer or runtime binding. */
function prepareFixtureCorrespondence(action: SourceFeedbackCorrespondenceAction): SourceFeedbackCorrespondenceResult {
  const { descriptor, original_query, query_semantics } = action.request;
  if (descriptor.interpretation === undefined) throw new Error("authored fixture requires an exposed full interpretation");
  const proposal = { original_query, admitted_query_semantics: query_semantics,
    source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id, interpretation: descriptor.interpretation }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID, producer_version: SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_VERSION };
  const meter = new SourceSemanticReadBudget(action.request.budget);
  meter.retain(proposal, "fixture correspondence request");
  const request = buildSourceSemanticCorrespondenceRequest(proposal);
  const predicate = request.catalog.query_endpoints.find(row => row.kind === "predicate" && row.frame === "qApproval")!;
  const frame = request.catalog.source_endpoints.find(row => row.kind === "frame" && row.frame === "fStatement")!;
  const rawJson = JSON.stringify({ contract: "source-semantic-correspondence-response-v4", outcome: { status: "interpreted", gaps: [] },
    semantic_correspondence: { contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
      assessments: assessmentForTestPairs(request.catalog, request.original_query, [{ query: predicate.handle, source: frame.handle,
        query_excerpt: "clearance", source_semantic_support: [{ kind: "lexical", mentions: ["mStatement"] }] }]) } });
  const received = proposeCorrespondenceSemantics(proposal, { rawJson }, meter);
  // The authored envelope is one injected receive, never a provider dispatch; the
  // file-level strict provider-free boundary owns the no-network claim.
  expect(received.provider_attempts).toBe(1);
  if (received.semantic_correspondence === undefined) throw new Error("authored correspondence must pass the existing receiver");
  return { action, status: "ready", semantic_correspondence: received.semantic_correspondence, new_dispatches: 0,
    historical_production: { status: "unknown" }, work: { logical_work: meter.spentWork, logical_memory_bytes: meter.spentBytes,
      native_work: meter.nativeWork, native_bytes: meter.nativeBytes, index_work: meter.indexWork, rss_bytes: process.memoryUsage.rss() } };
}
const fixtureHost: SourceFeedbackCorrespondenceHost = { policy_id: "authored-correspondence-fixture",
  prepare: async action => prepareFixtureCorrespondence(action) };

it("skips unrelated H and locally qualifies each actual ticket exposure without transferring seed bindings", async () => {
  const ids: string[] = [];
  for (const ticket of ["AP-42", "AP-73"]) {
    const q = parentQuery();
    await withFeedbackSource(ticket, async ({ client, session, native }) => {
      expect(native.result?.binding_results?.some(row => row.kind === "evidence" && row.input === 0)).toBe(true);
      let action!: SourceFeedbackCorrespondenceAction;
      const host: SourceFeedbackCorrespondenceHost = { policy_id: fixtureHost.policy_id, async prepare(exposed) {
        action = exposed;
        expect(exposed.request.descriptor.source_id).toBe("z");
        expect(exposed.request.access_hint).toBe(ticket);
        expect(exposed.request.descriptor.interpretation?.mentions.some(row => row.text.includes(ticket))).toBe(true);
        return prepareFixtureCorrespondence(exposed);
      } };
      const child = { ...session.action_budget, work_units: 1_000_000, memory_bytes: 80_000_000 };
      const plain = await client.sourceSemanticsPort!.execute({ ...CONTEXT, request: { kind: "prepare_query",
        original_query: ORIGINAL, query_semantics: q, budget: child } });
      if (plain.kind !== "prepare_query") throw new Error("original native pool required");
      expect(plain.access?.source_candidates.map(row => row.source_id)).not.toContain("z");
      expect(plain.candidates.some(row => row.source_id === "b")).toBe(true);
      const trace = await executeSourceFeedback({ session: { ...session, action_budget: child,
        budget: { ...child, work_units: child.work_units * 6, memory_bytes: child.memory_bytes * 6 } },
        context: CONTEXT, port: client.sourceSemanticsPort!, correspondence: host, timeoutMs: 30_000 });
      expect(trace.status).toBe("complete");
      expect(trace.qualification).toMatchObject({ status: "local" });
      expect(trace.exposures.map(row => row.result.kind)).toEqual(["prepare_source", "validate_source", "reason", "prepare_query", "reason"]);
      expect(trace.preparations).toHaveLength(1);
      expect(trace.preparations?.[0]).toMatchObject({ status: "ready", new_dispatches: 0, historical_production: { status: "unknown" } });
      const discovery = trace.exposures[3]!, local = trace.exposures[4]!.result;
      if (discovery.result.kind !== "prepare_query" || local.kind !== "reason") throw new Error("discovery and local native reason required");
      expect(action.request.origin_action_id).toBe(discovery.action_id);
      expect(action.request.origin_exposure_id).toBe(discovery.exposure_id);
      expect(action.request.query_handle).toBe(discovery.result.query_handle);
      expect(action.parent_entitlement_id).toBe(session.parent_entitlement_id);
      expect(discovery.result.access?.source_candidates.map(row => row.source_id)).toContain("z");
      expect(discovery.result.candidates.findIndex(row => row.source_id === "b")).toBeLessThan(
        discovery.result.candidates.findIndex(row => row.source_id === "z"));
      expect(discovery.result.truncated).toBe(true);
      expect(discovery.result.coverage.discovery).toBe("truncated");
      expect(local.coverage.discovery).toBe(discovery.result.coverage.discovery);
      expect(local.result?.source_interpretation_id).toBe(action.request.descriptor.interpretation_id);
      expect(local.result?.source_interpretation_id).not.toBe(session.seed.source_interpretation_id);
      expect(local.query).toEqual(q);
      expect(local.result?.query_semantics_id).toBe(sourceSemanticQueryIdentity(q, fieldContractSha256));
      expect(local.result?.binding_results?.some(row => row.kind === "evidence" && row.input === 1)).toBe(true);
      expect(local.result?.binding_results?.some(row => row.kind === "answer")).toBe(false);
      expect(local.result?.binding_results?.every(row => row.bindings.ticket === undefined)).toBe(true);
      expect(trace.qualification).toMatchObject({ status: "local", origin_exposure_id: discovery.exposure_id });
      expect(trace.joint_assessment.status).toBe("not_lowered");
      const hostWork = trace.preparations![0]!.work!;
      expect(hostWork.logical_work).toBeGreaterThan(0);
      expect(hostWork.logical_memory_bytes).toBeGreaterThan(0);
      expect(trace.accounting.logical_work).toBe(trace.exposures.reduce((n, row) => n + row.result.work.logical_work!, 0) + hostWork.logical_work!);
      expect(trace.accounting.reserved_work).toBe(0);
      ids.push(action.request.descriptor.interpretation_id);
    }, { original_query: ORIGINAL, query: q, provider_guard: STRICT_BOOTSTRAP,
      additional_sources: [{ id: "b", text: "M7 ticket clearance applies.", reading: "clearance" }] });
  }
  expect(new Set(ids).size).toBe(2);
}, 90_000);

it("preserves host unavailability, unknown occupancy, cancellation, expiry and source currentness", async () => {
  await withFeedbackSource("AP-42", async ({ client, session, filename }) => {
    for (const mode of ["unavailable", "unknown", "late_cancel", "expired", "stale"] as const) {
      const controller = new AbortController();
      const host: SourceFeedbackCorrespondenceHost = { policy_id: fixtureHost.policy_id, async prepare(action) {
        if (mode === "unavailable" || mode === "unknown") return { action, status: mode, reason: "fixture_host_unavailable",
          new_dispatches: 0, historical_production: { status: "unknown" },
          work: { logical_work: 1, logical_memory_bytes: 0, native_work: 0, native_bytes: 0, index_work: 0, rss_bytes: 1 } };
        const result = prepareFixtureCorrespondence(action);
        if (mode === "late_cancel") controller.abort(new Error("caller revoked during correspondence preparation"));
        if (mode === "stale") {
          // Another connection invalidates the exposed descriptor's query lease.
          const db = new DatabaseSync(filename);
          try { db.prepare("UPDATE source_records SET source_version='replacement' WHERE source_id='z'").run(); }
          finally { db.close(); }
        }
        return result;
      } };
      const child = { ...session.action_budget, work_units: 1_000_000, memory_bytes: 80_000_000 };
      const nativePort = client.sourceSemanticsPort!;
      const executionPort: SourceSemanticsExecutionPort = mode !== "expired" ? nativePort : { ...nativePort,
        execute: payload => nativePort.execute(payload.request.kind === "reason" && payload.request.query_handle !== undefined
          ? { ...payload, lifetime_now: "2026-09-18T00:11:00.000Z" } : payload) };
      const trace = await executeSourceFeedback({ session: { ...session, action_budget: child,
        budget: { ...child, work_units: 6 * child.work_units, memory_bytes: 6 * child.memory_bytes } },
        context: CONTEXT, port: executionPort, correspondence: host, signal: controller.signal, timeoutMs: 30_000 });
      expect(trace.exposures.map(row => row.result.kind)).toEqual(["prepare_source", "validate_source", "reason", "prepare_query"]);
      if (mode === "late_cancel" || mode === "unknown") {
        expect(trace).toMatchObject({ status: "unknown",
          accounting: { reserved_work: child.work_units, reserved_memory_bytes: child.memory_bytes } });
        if (mode === "late_cancel") expect(trace.terminal_cause).toMatchObject({ kind: "caller_abort" });
      } else if (mode === "stale" || mode === "expired") {
        expect(trace.status).toBe("failed");
        expect(trace.qualification).toMatchObject({ status: "unavailable", reason: "reason_failed",
          terminal_cause: { kind: "execution_error", reason: { details: { admission: mode === "stale" ? "filtered" : "expired" } } } });
        expect(trace.accounting.reserved_work).toBe(0);
      } else {
        expect(trace.qualification).toMatchObject({ status: "unavailable", reason: "fixture_host_unavailable" });
        expect(trace.preparations?.[0]?.new_dispatches).toBe(0);
        expect(trace.preparations?.[0]?.work?.logical_work).toBeGreaterThan(0);
      }
    }
  }, { original_query: ORIGINAL, query: parentQuery(), provider_guard: STRICT_BOOTSTRAP });
}, 90_000);

it.each(["missing", "off_page"] as const)("does not qualify an unrelated descriptor when the hint target is %s", async mode => {
  const additional = Array.from({ length: mode === "off_page" ? 17 : 1 }, (_, index) => ({
    id: `b${index.toString().padStart(2, "0")}`, text: "M7 ticket clearance applies.", reading: "clearance" }));
  await withFeedbackSource("AP-42", async ({ client, session, ids }) => {
    const prepare = vi.fn(fixtureHost.prepare);
    const child = { ...session.action_budget, work_units: 1_000_000, memory_bytes: 80_000_000 };
    const trace = await executeSourceFeedback({ session: { ...session, action_budget: child,
      budget: { ...child, work_units: 6 * child.work_units, memory_bytes: 6 * child.memory_bytes } }, context: CONTEXT,
      port: client.sourceSemanticsPort!, correspondence: { policy_id: "hint-target-policy", prepare }, timeoutMs: 30_000 });
    const discovery = trace.exposures[3]?.result;
    if (discovery?.kind !== "prepare_query") throw new Error("actual discovery required");
    expect(discovery.candidates.some(row => row.source_id.startsWith("b"))).toBe(true);
    if (mode === "missing") {
      expect(discovery.candidates.filter(row => row.interpretation_id !== session.seed.source_interpretation_id)
        .every(row => row.interpretation?.mentions.every(mention => !mention.text.includes("AP-42")))).toBe(true);
    }
    if (mode === "off_page") {
      expect(discovery.candidates.some(row => row.interpretation_id === ids.get("z")![0])).toBe(false);
      expect(discovery.candidates).toHaveLength(16);
      expect(discovery.access?.observed_interpretation_count).toBe(additional.length + 2);
      expect(discovery.truncated).toBe(true);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(trace.exposures.map(row => row.result.kind)).toEqual(["prepare_source", "validate_source", "reason", "prepare_query"]);
    expect(trace).toMatchObject({ status: "complete", preparations: [],
      qualification: { status: "unavailable", reason: "hint_descriptor_not_exposed" } });
  }, { original_query: ORIGINAL, query: parentQuery(), provider_guard: STRICT_BOOTSTRAP, additional_sources: additional,
    ...(mode === "off_page" ? { interpretation_census: "complete" } : { approval_ticket: "AP-73" }) });
}, 60_000);

it("does not split a purely conjunctive Q into evidence branches to manufacture feedback", async () => {
  await withFeedbackSource("AP-42", async ({ client, session, native }) => {
    expect(native.result?.outcome.status).toBe("interpreted");
    expect(native.result?.binding_results ?? []).toEqual([]);
    const prepare = vi.fn(fixtureHost.prepare);
    const trace = await executeSourceFeedback({ session, context: CONTEXT, port: client.sourceSemanticsPort!, timeoutMs: 30_000,
      correspondence: { policy_id: "conjunctive-policy", prepare } });
    expect(prepare).not.toHaveBeenCalled();
    expect(trace.status).toBe("non_actionable");
    expect(trace.exposures.map(row => row.result.kind)).toEqual(["prepare_source", "validate_source", "reason"]);
    expect(trace.joint_assessment.status).toBe("not_lowered");
  }, { original_query: ORIGINAL, query: parentQuery(false), provider_guard: STRICT_BOOTSTRAP });
}, 60_000);

it("binds the real daemon constructor to its matching dist feedback entry and preserves missing/closed admission", async () => {
  const directory = temporaryDirectory(), config = join(realpathSync(tmpdir()), `alaya-bench-config-${randomUUID()}`);
  roots.push(config); mkdirSync(config);
  const workspaceRoot = join(directory, "workspace"); mkdirSync(workspaceRoot);
  // Persist disabled config through its owner; startup never needs credential-derived defaults.
  const databasePath = join(config, "alaya.db");
  writeFileSync(join(config, "alaya.toml"), `[storage]\ndb_path = ${JSON.stringify(databasePath)}\n`);
  const database = initDatabase({ filename: databasePath });
  try {
    new SqliteConfigRepo(database).setParsed("runtime:garden-compute", {
      config_version: 1, provider_kind: "host_worker", model_id: null,
      provider_url: null, secret_ref: null, enabled: false
    }, RuntimeGardenComputeConfigSchema);
  } finally { database.close(); closeCachedDatabase(databasePath); }
  for (const [key, value] of Object.entries({ DATA_DIR: join(directory, "data"), ALAYA_CONFIG_DIR: config,
    HOME: join(directory, "home"), CODEX_HOME: join(directory, "codex-home"),
    ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false", ALAYA_EMBEDDING_PROVIDER: "local_onnx", ALAYA_SQLITE_WRITE_QUEUE: "0",
    ALAYA_CONFLICT_LLM_PROVIDER_URL: "", ALAYA_CONFLICT_LLM_MODEL: "", ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "false" })) {
    vi.stubEnv(key, value);
  }
  // Supply only absence for daemon control-plane knobs; provider credential reads remain guarded.
  const guardedEnvironment = process.env;
  const fixtureKnobs = new Map<string, string | undefined>([["ALAYA_REQUEST_TOKEN", undefined],
    ["ALAYA_REQUEST_TOKEN_WORKSPACES", undefined], ["ALAYA_REVIEWER_TOKEN", undefined],
    ["ALAYA_MCP_TOOL_CONFIRMATION_TOKEN", undefined], ["ALAYA_E2E_EVENT_TRIGGER_TOKEN", undefined]]);
  process.env = new Proxy(guardedEnvironment, { get(target, key) {
    return typeof key === "string" && fixtureKnobs.has(key) ? fixtureKnobs.get(key) : Reflect.get(target, key);
  } });
  const guard = `--import=${STRICT_BOOTSTRAP.href}`;
  process.execArgv.push(guard);
  let runtime: import("../../../index.js").AlayaDaemonRuntime | undefined;
  try {
    // Constructor and entry must share compiled module identity, not a source-side test registry.
    const daemon: typeof import("../../../index.js") = await import(/* @vite-ignore */ new URL("../../../../dist/index.js", import.meta.url).href);
    const execution: typeof import("../../../runtime/recall/source-feedback-execution.js") = await import(
      /* @vite-ignore */ new URL("../../../../dist/runtime/recall/source-feedback-execution.js", import.meta.url).href);
    runtime = await daemon.createAlayaDaemonRuntime({ embeddingStartupProbe: "omit" });
    await expect(runtime.services.embeddingProviderWarmup).resolves.toBe("not_requested");
    await runtime.services.workspaceService.ensureLocalWorkspace({ workspaceId: CONTEXT.workspace_id,
      name: "Feedback admission", rootPath: workspaceRoot });
    const digest = `sha256:${"0".repeat(64)}`;
    const session: SourceFeedbackSessionInput = { request_id: "daemon-admission", parent_entitlement_id: "daemon-admission-allowance",
      workspace_id: CONTEXT.workspace_id, original_query: ORIGINAL, as_of: CONTEXT.as_of,
      scope_identity: canonicalJson([CONTEXT.principal, CONTEXT.authorized_scopes]), source_id: "absent-for-admission",
      source_target: { kind: "source_evidence", workspace_id: CONTEXT.workspace_id, root_kind: "source_record", root_id: digest,
        source_version: "1", content_digest: digest, evidence_object_id: null },
      seed: { kind: "reason", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL,
        source_interpretation_id: digest, budget: CHILD, output_byte_limit: 1_000_000 }, budget: CHILD, action_budget: CHILD };
    const input = { session, context: CONTEXT, timeoutMs: 20_000 };
    await expect(execution.executeSourceFeedbackForRuntime({ ...runtime }, input)).rejects.toMatchObject({
      code: "CONFLICT", message: "source feedback execution port is not bound" });
    const live = await execution.executeSourceFeedbackForRuntime(runtime, input);
    expect(live.status).toBe("failed");
    expect(live.settlements).toHaveLength(1);
    expect(live.accounting.logical_work).toBeGreaterThan(0);
    expect(live.exposures).toEqual([]);
    await runtime.shutdown();
    const closed = await execution.executeSourceFeedbackForRuntime(runtime, input);
    expect(closed).toMatchObject({ status: "unknown", exposures: [], settlements: [],
      terminal_cause: { kind: "execution_error", code: "CONFLICT", message: "recall read worker is closed" },
      accounting: { reserved_work: 0, reserved_memory_bytes: 0 } });
  } finally {
    try { await runtime?.shutdown(); }
    finally { process.execArgv.splice(process.execArgv.lastIndexOf(guard), 1); process.env = guardedEnvironment; }
  }
}, 60_000);
