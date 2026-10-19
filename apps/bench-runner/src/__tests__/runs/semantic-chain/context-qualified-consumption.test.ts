import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { checkpointAndCopyBenchDb } from "../../../runs/snapshot/materialize.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { admitRetainedNativeSourceSnapshot, readVerifiedNativeSourceSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { buildSourceSemanticWorkerPayload } from "../../../../../core-daemon/src/mcp-memory/tool/interpretation-handler.js";
import { createRecallReadWorkerClient } from "../../../../../core-daemon/src/runtime/recall/recall-read-worker-client.js";
import { compareResearchSourceQualifiedSelection } from "../../../../../core-daemon/src/runtime/recall/source-semantic-research-acquisition-controls.js";
import { builtWorkerUrl } from "../../../../../core-daemon/src/__tests__/runtime/recall/recall-read-worker-client-fixture.js";
import { deriveAddressableSpanViews, fieldContractSha256 } from "@do-soul/alaya-core";
import { canonicalJson, sourceSemanticInterpretationIdentity } from "@do-soul/alaya-protocol";
import { qualifiedSelectionFixture, authoredProposal, correspondenceRaw } from "./source-qualified-selection.test-support.js";
import { materializeSemanticProposalLines } from "../../../runs/semantic-proposal/workset.js";
import { admitSourceQualifiedSelection, qualifiedSelectionInputPaths } from "../../../runs/semantic-chain/source-qualified-selection-input.js";
import { correspondenceAssessmentJson } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-producer-fixture.js";
import { syntheticGeminiBody } from "../semantic-proposal/gemini-response-evidence.test-support.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { chainIdentity } from "../../../runs/semantic-chain/contract.js";
import { executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { assertContextQualifiedDelivery } from "../../../runs/semantic-chain/source-qualified-correspondence-context.js";
import type { CorrespondenceGenerationContext } from "../../../runs/semantic-proposal/correspondence-generation-context.js";
import type { SourceAcquisitionExperimentInput } from "../../../runs/semantic-chain/source-acquisition-experiment.js";
import type { readSourceExperiment } from "../../../runs/semantic-chain/source-experiment.js";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });
async function fixture() {
  vi.stubEnv("ALAYA_CONFLICT_LLM_PROVIDER_URL", ""); vi.stubEnv("ALAYA_CONFLICT_LLM_MODEL", "");
  const directory = mkdtempSync(join(tmpdir(), "context-qualified-")); roots.push(directory);
  const h = await qualifiedSelectionFixture(directory), rows = h.input.qualified_selection!.nominees.filter(row => row.correspondence !== undefined);
  const target = rows[0]!, context = rows[1]!, c = target.correspondence!;
  const runtime = { target_interpretation_id: target.interpretation!.interpretation_id,
    additional_interpretation: { source_interpretation_id: context.interpretation!.interpretation_id,
      interpretation: context.interpretation!.interpretation! } };
  return { ...h, target, context, c, runtime };
}
it("commits one additional H into the native full-assessment request key without widening the persisted workset", async () => {
  const h = await fixture();
  const ordinary = materializeSemanticProposalLines(h.c.workset, h.c.max_output_tokens)[0]!;
  const contextual = materializeSemanticProposalLines(h.c.workset, h.c.max_output_tokens, undefined, undefined, h.runtime)[0]!;
  expect(contextual.key).not.toBe(ordinary.key);
  expect(contextual.request).toHaveProperty("source_interpretation_descriptors", [
    ...JSON.parse(ordinary.userPrompt).source_interpretation_descriptors, h.runtime.additional_interpretation]);
  expect((h.c.workset.items[0] as { source_interpretation_descriptors: unknown[] }).source_interpretation_descriptors).toHaveLength(1);
}, 60000);

async function contextualFixture() {
  const h = await fixture();
  const cache = join(h.directory, "contextual-c-history");
  const produced = await authoredProposal(h.c.workset, cache, correspondenceRaw, h.runtime);
  h.c.cache_root = cache; h.c.artifact = produced.artifact;
  return { ...h, produced };
}
async function invoke(input: SourceAcquisitionExperimentInput, context?: CorrespondenceGenerationContext) {
  const path = join(input.root, "..", "context-caller.json");
  writeFileSync(path, JSON.stringify({ input, correspondenceGenerationContext: context, mutateCorrespondenceContextAfterCall: context !== undefined }));
  return await new Promise<ReturnType<typeof readSourceExperiment>>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./source-acquisition-caller.test-support.mjs", import.meta.url)), path],
      { env: { ...process.env, NODE_OPTIONS: "", ALAYA_RECALL_READ_WORKER_REQUEST_TIMEOUT_MS: "60000" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => {
      if (code !== 0) reject(new Error(`context caller ${code}: ${stderr}`));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
  });
}
it("requires exact context through SQLite, the owned consumer and worker; historical readback never renews live qualification", async () => {
  const h = await contextualFixture(), input = h.input.qualified_selection!;
  expect(() => qualifiedSelectionInputPaths(h.input.config, input)).toThrow(/exact producer key/u);
  expect(() => admitSourceQualifiedSelection(h.input.config, input)).toThrow(/exact producer key/u);
  const producer = admitSourceQualifiedSelection(h.input.config, input, undefined, h.runtime);
  expect(producer.status).toBe("ready");
  expect(readSemanticProposalResults(h.c.workset, h.c.cache_root, h.c.max_output_tokens)[0]!.line.key).not.toBe(h.c.artifact.key);
  expect(readSemanticProposalResults(h.c.workset, h.c.cache_root, h.c.max_output_tokens)[0]!.status).toBe("unattempted");
  const blocked = await invoke(h.input);
  expect(blocked).toMatchObject({ status: "blocked", execution_started: false });
  const state = await invoke(h.input, h.runtime);
  expect(state.lifetime.status, canonicalJson(state)).toBe("closed");
  if (state.execution === undefined || !("qualified_comparison" in state.execution)) throw new Error(canonicalJson(state));
  const result = state.execution.qualified_comparison;
  expect(result.comparison!.outcome).toBe("complete");
  expect(result.comparison!.selection!.eligibility.filter(row => row.h === "ready")).toHaveLength(5);
  expect(result.comparison!.selection!.eligibility.find(row => row.source.current.record_id === h.target.current.record_id)!.c).toBe("admitted");
  for (const arm of Object.values(result.comparison!.selection!.arms)) expect(arm!.artifact.proofs!.length).toBeGreaterThan(0);
  expect(() => assertContextQualifiedDelivery(input, h.runtime, { ...result.comparison!, selection: {
    ...result.comparison!.selection!, eligibility: result.comparison!.selection!.eligibility.map(row => row.source.current.record_id === h.context.current.record_id
      ? { ...row, h: "rejected" as const } : row) } })).toThrow(/both exact interpretations/u);
  for (const failure of ["removed", "new_tuple", "changed_context"] as const) {
    const changed = structuredClone(h.input), population = changed.qualified_selection!;
    let context = h.runtime;
    if (failure === "removed") population.nominees = population.nominees.filter(row => row.current.record_id !== h.context.current.record_id);
    if (failure === "new_tuple") population.nominees.find(row => row.current.record_id === h.context.current.record_id)!.current.source_version = "fresh-version";
    if (failure === "changed_context") context = { ...h.runtime, additional_interpretation: { ...h.runtime.additional_interpretation,
      interpretation: { ...h.runtime.additional_interpretation.interpretation,
        producer_version: "different-context" } } };
    changed.root = join(h.directory, failure);
    expect(await invoke(changed, context)).toMatchObject({ status: "blocked", execution_started: false });
  }
  // Structurally valid generation history is not proof that H2 is published/current.
  const unready = structuredClone(h.input), unreadyContext = structuredClone(h.runtime);
  const unpublished = { ...unreadyContext.additional_interpretation.interpretation, producer_version: "unpublished-context" };
  const unpublishedId = sourceSemanticInterpretationIdentity(unpublished, fieldContractSha256);
  unreadyContext.additional_interpretation = { source_interpretation_id: unpublishedId, interpretation: unpublished };
  const unreadyMember = unready.qualified_selection!.nominees.find(row => row.current.record_id === h.context.current.record_id)!;
  unreadyMember.interpretation = { ...unreadyMember.interpretation!, interpretation_id: unpublishedId,
    producer_version: unpublished.producer_version, interpretation: unpublished };
  delete unreadyMember.correspondence; // Isolate H2 publication readiness from its unrelated old local C.
  const unreadyC = unready.qualified_selection!.nominees.find(row => row.current.record_id === h.target.current.record_id)!.correspondence!;
  unreadyC.cache_root = join(h.directory, "unpublished-context-c");
  unreadyC.artifact = (await authoredProposal(unreadyC.workset, unreadyC.cache_root, correspondenceRaw, unreadyContext)).artifact;
  unready.root = join(h.directory, "unpublished-context");
  const rejected = await invoke(unready, unreadyContext);
  expect(rejected.execution).toHaveProperty("qualified_failure");
  expect(rejected.execution).not.toHaveProperty("qualified_comparison");
  expect(canonicalJson(rejected.execution)).toContain("both exact interpretations ready");
  expect(rejected.execution).toMatchObject({ qualified_failure: { comparison: { outcome: "complete", selection: {
    eligibility: expect.arrayContaining([expect.objectContaining({ h: "rejected", source: expect.objectContaining({
      current: expect.objectContaining({ record_id: h.context.current.record_id }) }) })]),
    work: { logical_work: expect.any(Number), logical_memory_bytes: expect.any(Number) } } } } });
  if (rejected.execution === undefined || !("qualified_failure" in rejected.execution)) throw new Error("failure evidence required");
  expect(rejected.execution.qualified_failure.comparison?.selection?.work.logical_work).toBeGreaterThan(0);
  rmSync(unreadyC.cache_root, { recursive: true });
  const unreadyHistory = await invoke(unready);
  expect(unreadyHistory.execution).toEqual(rejected.execution);
  expect(unreadyHistory.execution).not.toHaveProperty("qualified_comparison");
  // A fresh root enters the native snapshot again; it does not reuse a historical delivery lease.
  const fresh = { ...h.input, root: join(h.directory, "fresh-snapshot-use") };
  expect((await invoke(fresh, h.runtime)).lifetime.status).toBe("closed");
  for (const name of readdirSync(h.root).filter(name => name.endsWith(".json"))) {
    expect(readFileSync(join(h.root, name), "utf8")).not.toContain("additional_interpretation");
  }
  rmSync(h.input.config.snapshot_path); rmSync(h.c.cache_root, { recursive: true });
  expect((await invoke(h.input)).execution).toEqual(state.execution);
  expect((await invoke(unready)).execution).toEqual(rejected.execution);
  const unavailable = { ...h.input, root: join(h.directory, "missing-live-inputs") };
  expect(await invoke(unavailable, h.runtime)).toMatchObject({ status: "blocked", execution_started: false });
}, 120000);

it("rejects old C after an owned SQLite H2 version publication, including fresh sealed populations with new current tuples", async () => {
  const h = await contextualFixture(); // C generation precedes the source publication below.
  const producer = admitSourceQualifiedSelection(h.input.config, h.input.qualified_selection!, undefined, h.runtime);
  if (producer.status !== "ready") throw new Error("received producer required");
  const before = readVerifiedNativeSourceSnapshot(h.input.config.snapshot_path).records.find(row => row.record.identity === h.context.current.record_id)!;
  const daemon = await startBenchDaemon({ dataDirRoot: join(h.directory, "source"), workspaceId: h.input.config.workspace_id,
    runId: h.input.config.run_id, embeddingMode: "disabled", embeddingStartupProbe: "omit", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  try {
    const changed = await daemon.importSourceRecord({ source_id: before.record.source_id, source_version: "2", content_bytes: before.content_bytes,
      event_time: before.record.event_time, recorded_at: "2026-09-26T00:00:00.000Z", speaker: "user",
      attribution_context: before.record.attribution_context!, valid_from: null, valid_to: null, scope_class: "project",
      spans: deriveAddressableSpanViews(before.content_bytes) });
    expect(changed.record.source_version).toBe("2"); expect(changed.record.identity).not.toBe(h.context.current.record_id);
    await daemon.checkpointFieldProjection();
  } finally { await daemon.shutdown(); }
  const mutated = join(h.directory, "published-version.sqlite");
  checkpointAndCopyBenchDb(join(h.directory, "source", "alaya.db"), mutated);
  // The immutable native seal cannot hide retained noncurrent rows. Exercise currentness through the actual worker instead.
  await expect(admitRetainedNativeSourceSnapshot({ retainedPath: mutated, expectedSha256: hashRegularFileNoFollow(mutated),
    snapshotPath: join(h.directory, "rejected-version-seal.sqlite"), workspaceId: h.input.config.workspace_id,
    runId: h.input.config.run_id, producerCommit: "0".repeat(40) })).rejects.toThrow("noncurrent record");
  const payload = buildSourceSemanticWorkerPayload({ now: () => "2026-09-26T00:00:00.000Z", interpretationClock: h.input.config.interpretation_clock },
    { workspaceId: h.input.config.workspace_id, runId: h.input.config.run_id, sessionId: "source-version-mutation", agentTarget: "bench" },
    { kind: "recall", accepts_unreviewed_conditional_results: true, original_query: h.input.original_query,
      query_semantics: producer.query_semantics, semantic_correspondences: producer.semantic_correspondences,
      access_policy: "query-conditioned-v1", budget: h.input.config.budget, output_byte_limit: h.input.config.output_byte_limit }, h.input.config.authorized_scopes);
  const client = createRecallReadWorkerClient({ databaseFilename: mutated, workerUrl: builtWorkerUrl,
    workerCount: 1, requestTimeoutMs: 60000, prepareSourceQuery: async () => { throw new Error("model preparation forbidden"); } })!;
  try {
    const compared = await compareResearchSourceQualifiedSelection(client, payload, producer.population, { timeoutMs: 60000 });
    expect(compared.outcome).toBe("failed");
    expect(compared.selection!.failure!.message).toContain("raw root is not current");
    expect(compared.selection!.arms).toEqual({ default: null, evidence_set_coverage: null });
  } finally { await client.close(); }
  // Reproduce the changed current population through native import/publication owners on a fresh seal;
  // retain the old C and generation context, never regenerate or rewrite them to match version 2.
  const fresh = await qualifiedSelectionFixture(join(h.directory, "fresh-current-seal"), { [h.context.current.source_id]: "2" });
  const population = fresh.input.qualified_selection!, target = population.nominees.find(row => row.current.source_id === h.target.current.source_id)!;
  const current = population.nominees.find(row => row.current.source_id === h.context.current.source_id)!;
  expect(current.current.source_version).toBe("2"); expect(current.current.record_id).not.toBe(h.context.current.record_id);
  expect(current.interpretation!.interpretation_id).not.toBe(h.context.interpretation!.interpretation_id);
  expect(target.interpretation!.interpretation_id).toBe(h.runtime.target_interpretation_id);
  target.correspondence = h.c;
  const rejected = await invoke(fresh.input, h.runtime);
  expect(rejected).toMatchObject({ status: "blocked", phase: "admission", execution_started: false });
  expect(canonicalJson(rejected)).toContain("exact required qualified nominee");
  // Keeping old H2 while substituting the genuinely published current tuple cannot refresh old C either.
  current.interpretation = h.context.interpretation; delete current.correspondence;
  expect(await invoke({ ...fresh.input, root: join(h.directory, "fresh-tuple-old-h") }, h.runtime)).toMatchObject({ status: "blocked", execution_started: false });
  // An old exact generation tuple passes host context binding but fails the fresh owned child's sealed membership check.
  current.current = h.context.current; current.nominee = h.context.nominee;
  const stale = await invoke({ ...fresh.input, root: join(h.directory, "fresh-child-old-tuple") }, h.runtime);
  expect(stale.lifetime.status).toBe("failed"); expect(stale.execution).toHaveProperty("qualified_failure");
  expect(canonicalJson(stale.execution)).toContain("nominee differs from its complete sealed source snapshot");
  expect(stale.execution).not.toHaveProperty("qualified_comparison");
}, 120000);

it.each(["H2_selected", "foreign_H2_handle"] as const)("retains %s raw evidence without qualifying it as an H1 result", async failure => {
  const h = await fixture(), cache = join(h.directory, failure);
  const line = materializeSemanticProposalLines(h.c.workset, h.c.max_output_tokens, undefined, undefined, h.runtime)[0]!;
  const request = JSON.parse(line.userPrompt);
  let raw = correspondenceAssessmentJson({ ...request, producer_id: request.producer_capability.producer_id,
    producer_version: request.producer_capability.producer_version }, { source_interpretation_handle: "source2", correspondences: [] });
  if (failure === "foreign_H2_handle") {
    const response = JSON.parse(correspondenceRaw(line.userPrompt));
    const pair = response.semantic_correspondence.assessments.find((row: { status: string }) => row.status === "supported").equivalents[0];
    pair.source = request.catalog.source_endpoints.find((row: { source_interpretation_handle: string }) => row.source_interpretation_handle === "source2").handle;
    raw = JSON.stringify(response);
  }
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(h.c.workset, cache, h.c.max_output_tokens, 1, undefined, h.runtime),
    inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  await executeSemanticProposalFill({ workset: h.c.workset, cacheRoot: cache, authority, correspondenceGenerationContext: h.runtime,
    config: { model: h.c.workset.model, requestProfile: "gemini-3.1-minimal-v1", providerUrl: h.c.workset.provider_url, apiKey: null },
    extractor: { extract: async () => ({ rawJson: raw, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      responseMetadata: { finishReason: "STOP" }, responseBody: syntheticGeminiBody(raw, "STOP", { inputTokens: 0, outputTokens: 0, totalTokens: 0 }) }) } });
  const row = readSemanticProposalResults(h.c.workset, cache, h.c.max_output_tokens, undefined, undefined, h.runtime)[0]!;
  expect(row.status).not.toBe("interpreted"); expect(row.shard!.raw_json).toBe(raw);
  h.c.cache_root = cache; h.c.artifact = { key: line.key, cache_identity: chainIdentity(row.shard),
    historical_production: { status: "reported", usage: row.shard!.usage } };
  expect(() => admitSourceQualifiedSelection(h.input.config, h.input.qualified_selection!, undefined, h.runtime)).toThrow(/no admitted H1 target result/u);
  const rejected = await invoke(h.input, h.runtime);
  expect(rejected.execution).toHaveProperty("qualified_failure"); expect(rejected.execution).not.toHaveProperty("qualified_comparison");
}, 60000);
