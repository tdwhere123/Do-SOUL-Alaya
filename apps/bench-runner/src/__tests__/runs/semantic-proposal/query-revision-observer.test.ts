import { afterAll, afterEach, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { qualifiedSelectionFixture } from "../semantic-chain/source-qualified-selection.test-support.js";
import { admitSourceQualifiedSelection, qualifiedSelectionInputPaths } from "../../../runs/semantic-chain/source-qualified-selection-input.js";
import { chainIdentity, readChainArtifact } from "../../../runs/semantic-chain/contract.js";
import type { readSourceExperiment } from "../../../runs/semantic-chain/source-experiment.js";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import * as soul from "@do-soul/alaya-soul";
import * as artifacts from "../../../runs/semantic-proposal/artifact.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { openSemanticProposalAttemptLedger, semanticProposalLookup, semanticProposalCacheInputPaths } from "../../../runs/semantic-proposal/attempt.js";
import { executeSemanticProposalFill, prepareSemanticProposal, prepareRetainedSemanticProposalRevision,
  readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset, resolveSemanticProposalRevisionParent,
  type RetainedSemanticQueryParent } from "../../../runs/semantic-proposal/workset.js";
import { captureQueryRevisionObserverView, type QueryRevisionObserverView }
  from "../../../runs/semantic-proposal/query-revision-observer-view.js";
import { ledgerPath } from "../../../runs/extraction/authority/attempt-ledger.js";
import { STEP_PLAN_QUOTE_BASIS as basis } from "../../../runs/extraction/authority/step-quote.js";
import { providerRawAttemptPath, readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { createSemanticProviderHttpExtractor, prepareSemanticProviderRequest }
  from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { fetchLoopbackProvider } from "../../support/loopback-provider-fetch.js";
import { MIRA_QUERY, meaningBody, nestedMeaningBody } from "./query-response.test-support.js";
import { syntheticGeminiBody } from "./gemini-response-evidence.test-support.js";

// No public DNS lookup is needed: the unchanged native request is transported only over the guarded local socket.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async (_host: string, options?: { all?: boolean }) => {
  const answer = { address: "93.184.216.34", family: 4 }; return options?.all ? [answer] : answer;
}) }));

const roots: string[] = [], servers: Server[] = [];
const cap = 4096;
const config = { providerUrl: basis.selected_provider_url, model: basis.selected_model,
  requestProfile: "step-3.5-2603-low-json-schema-v1" as const, apiKey: "loopback-only" };
const rates = { inputUsdPerMillion: basis.input_usd_equivalent_per_million,
  outputUsdPerMillion: basis.output_usd_equivalent_per_million };
const presentations = ["flat-carrier-v1", "nested-meaning-v1"] as const;
type Presentation = typeof presentations[number];
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => { try { expect(isolation.violations).toEqual([]); } finally { isolation.restore(); } });

function rejectedBody(presentation: Presentation): string {
  if (presentation === "flat-carrier-v1") return meaningBody("parcel");
  const body = JSON.parse(nestedMeaningBody());
  const alternative = body.query.alternatives[0];
  alternative.evidence_inputs = [{ conditions: [structuredClone(alternative.conditions[0])] }];
  return JSON.stringify(body);
}

async function fixture(presentation: Presentation = "flat-carrier-v1") {
  const root = mkdtempSync(join(tmpdir(), "query-revision-observer-")); roots.push(root);
  const parentRoot = join(root, "parent"), childRoot = join(root, "child");
  const item = { original_query: MIRA_QUERY, generation_presentation: presentation };
  const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v4", kind: "query",
    model: config.model, request_profile: config.requestProfile, provider_url: config.providerUrl, items: [item] });
  const wires: { path: string | undefined; body: string }[] = [];
  let rawJson = rejectedBody(presentation);
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    wires.push({ path: request.url, body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: rawJson }, finish_reason: "stop" }],
      usage: { prompt_tokens: 17, completion_tokens: 12, total_tokens: 29,
        completion_tokens_details: { reasoning_tokens: 4 } } })}\n\ndata: [DONE]\n\n`);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, guardedFetch = globalThis.fetch;
  const fetchImpl: typeof fetch = (url, init) => {
    const selected = new URL(String(url));
    expect(selected.href).toBe("https://api.stepfun.com/step_plan/v1/chat/completions");
    return fetchLoopbackProvider(guardedFetch, new URL(selected.pathname, origin), init);
  };
  const extractor = createSemanticProviderHttpExtractor(config, "source_semantic_proposal", fetchImpl);
  const historical = vi.spyOn(soul, "sourceSemanticQuerySystemPrompt").mockReturnValue("Retained historical query guidance.");
  const parentLine = materializeSemanticProposalLines(workset, cap)[0]!;
  const retained: RetainedSemanticQueryParent = { key: parentLine.key, request_digest: parentLine.requestDigest,
    system_prompt: parentLine.systemPrompt, model: workset.model, request_profile: workset.request_profile,
    provider_url: workset.provider_url, max_output_tokens: cap };
  const parentAuthority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, parentRoot, cap, 1), ...rates });
  const parentFill = executeSemanticProposalFill({ workset, cacheRoot: parentRoot, authority: parentAuthority, config, extractor });
  if (presentation === "nested-meaning-v1") await expect(parentFill).rejects.toThrow(/stopped after terminal/u);
  else await expect(parentFill).resolves.toMatchObject({ rejected: 1, attempts: 1 });
  historical.mockRestore();
  const revision = prepareRetainedSemanticProposalRevision({ workset, parentCacheRoot: parentRoot,
    maxOutputTokens: cap, itemIndex: 0, retainedParent: retained });
  const child = parseSemanticProposalWorkset({ ...workset, revision_parent_cache_root: parentRoot,
    items: [{ ...item, revision, retained_parent: retained }] });
  const locations = presentation === "flat-carrier-v1" ? ["/query/nodes/0/arguments/1/excerpt"] :
    ["/query/alternatives/0/conditions/0", "/query/alternatives/0/evidence_inputs/0/conditions/0"];
  const view = captureQueryRevisionObserverView({ kind: "observer-authored-mechanical-observations",
    parent_key: retained.key, parent_request_digest: retained.request_digest,
    parent_request_sha256: revision.parent_request_sha256, previous_response_sha256: revision.previous_response_sha256,
    observations: [{ locations: locations.map(pointer => ({ document: "previous_response", pointer })),
      text: presentation === "flat-carrier-v1"
        ? "Observer observation: the support excerpt at this location is not a contiguous substring of the unchanged original question."
        : "Observer observation: these two locations within the same alternative contain full statement declarations with the same occurrence key.",
      provenance: "Observer-authored manual comparison of the original question and exact retained response; not native Core diagnostics." }] });
  const line = materializeSemanticProposalLines(child, cap, undefined, view)[0]!;
  const prepare = (selected: QueryRevisionObserverView = view) => prepareSemanticProposal(child, childRoot, cap, 1, selected);
  const bind = () => pinSemanticProposalAuthority({ preflight: prepare(), ...rates });
  const read = (selected: QueryRevisionObserverView = view, meter?: SourceSemanticResourceLedger) =>
    readSemanticProposalResults(child, childRoot, cap, meter, selected)[0]!;
  const completeBody = presentation === "flat-carrier-v1" ? meaningBody("sample") : nestedMeaningBody();
  return { root, parentRoot, childRoot, workset, child, parentLine, retained, revision, view, line, prepare, bind, read,
    wires, extractor, setBody: (body = completeBody) => { rawJson = body; }, completeBody };
}

it("binds observer Q inventory and native readmission through the owned guarded process without persisting its runtime view", async () => {
  const f = await fixture(); f.setBody();
  await executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority: f.bind(), config,
    extractor: f.extractor, queryRevisionObserverView: f.view });
  const h = await qualifiedSelectionFixture(join(f.root, "mechanism-only-sources"));
  h.input.original_query = MIRA_QUERY;
  h.input.config.query_workset = f.child; h.input.config.query_cache_root = f.childRoot; h.input.config.max_output_tokens = cap;
  for (const nominee of h.input.qualified_selection!.nominees) delete nominee.correspondence;
  const q = f.read();
  h.input.qualified_selection!.query = { key: q.line.key, cache_identity: chainIdentity(q.shard),
    historical_production: { status: "reported", usage: q.shard!.usage } };
  const selection = h.input.qualified_selection!;
  expect(() => qualifiedSelectionInputPaths(h.input.config, selection)).toThrow(/exact producer key/u);
  expect(() => admitSourceQualifiedSelection(h.input.config, selection)).toThrow(/exact producer key/u);
  const wrong = structuredClone(f.view); (wrong.observations[0] as { text: string }).text = "Changed observer view.";
  for (const view of [wrong, { ...f.view, parent_key: "a".repeat(64) }]) {
    expect(() => qualifiedSelectionInputPaths(h.input.config, selection, view)).toThrow();
    expect(() => admitSourceQualifiedSelection(h.input.config, selection, view)).toThrow();
  }
  const paths = qualifiedSelectionInputPaths(h.input.config, selection, f.view);
  expect(paths).toContain(artifacts.semanticProposalShardPath(f.childRoot, f.line.key));
  expect(paths).toContain(artifacts.semanticProposalShardPath(f.parentRoot, f.parentLine.key));
  expect(admitSourceQualifiedSelection(h.input.config, selection, f.view).status).toBe("ready");
  const invoke = async (view?: QueryRevisionObserverView, bootstrapSendFailure = false) => {
    const input = bootstrapSendFailure ? { ...h.input, root: join(f.root, "send-failure") } : h.input;
    const path = join(f.root, "runtime-caller.json"); writeFileSync(path, JSON.stringify({ input, runtimeView: view,
      mutateRuntimeViewAfterCall: view !== undefined, bootstrapSendFailure }));
    return await new Promise<ReturnType<typeof readSourceExperiment>>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../semantic-chain/source-acquisition-caller.test-support.mjs", import.meta.url)), path],
        { env: { ...process.env, NODE_OPTIONS: "", ALAYA_RECALL_READ_WORKER_REQUEST_TIMEOUT_MS: "60000", ALAYA_CONFLICT_LLM_PROVIDER_URL: "", ALAYA_CONFLICT_LLM_MODEL: "" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let stdout = "", stderr = "";
      child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; });
      child.on("error", reject); child.on("close", code => {
        if (code !== 0) reject(new Error(`guarded observer caller ${code}: ${stderr}`));
        else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
      });
    });
  };
  expect(await invoke()).toMatchObject({ status: "blocked", phase: "admission", execution_started: false });
  expect(await invoke(wrong)).toMatchObject({ status: "blocked", phase: "admission", execution_started: false });
  const failedSend = await invoke(f.view, true);
  expect(failedSend.lifetime.status).toBe("failed"); expect(failedSend.execution).toBeUndefined();
  expect((await invoke(f.view, true)).execution).toBeUndefined(); // Held reservation never redispatches.
  const state = await invoke(f.view);
  expect(state.lifetime.status, JSON.stringify(state)).toBe("closed");
  expect(state.execution).toMatchObject({ qualified_comparison: { producer: { status: "ready", new_dispatches: 0 }, comparison: { outcome: "complete" } } });
  expect(f.wires).toHaveLength(2);
  const launch = readChainArtifact(join(h.root, "source-experiment-launch.json"));
  expect(JSON.stringify(launch)).not.toContain(f.view.observations[0]!.text);
  for (const name of readdirSync(h.root).filter(name => name.endsWith(".json"))) {
    const text = readFileSync(join(h.root, name), "utf8");
    expect(text).not.toContain(f.view.observations[0]!.text);
    expect(text).not.toContain("observer-authored-mechanical-observations");
  }
  rmSync(f.childRoot, { recursive: true }); rmSync(f.parentRoot, { recursive: true }); rmSync(h.input.config.snapshot_path);
  expect((await invoke()).execution).toEqual(state.execution);
}, 120_000);

it.each(presentations)("keeps the default %s system/user/schema/key and exact original parent witness unchanged", async presentation => {
  const f = await fixture(presentation), before = JSON.stringify({ child: f.child, view: f.view });
  const current = materializeSemanticProposalLines(f.child, cap)[0]!;
  const request = soul.buildSourceSemanticQueryRequest({ original_query: MIRA_QUERY, generation_presentation: presentation,
    producer_id: "alaya.source.semantic.query.soul.v1", producer_version: "1", revision: f.revision });
  // Independent expectation uses the public v1 owner, not the experimental renderer or cache-key wrapper.
  expect(current.request).toEqual(request);
  expect(current.userPrompt).toBe(JSON.stringify(request));
  expect(current.systemPrompt).toBe(soul.sourceSemanticQuerySystemPrompt(request));
  expect(current.responseJsonSchema).toEqual(soul.sourceSemanticQueryResponseJsonSchema(request));
  const wire = prepareSemanticProviderRequest(config, { systemPrompt: current.systemPrompt, userPrompt: current.userPrompt,
    responseJsonSchema: current.responseJsonSchema, maxOutputTokens: cap, outputTokenField: "max_tokens", retryMode: "disabled" },
  "source_semantic_proposal");
  const key = createHash("sha256").update(["source-semantic-proposal-workset-v4", config.model, config.requestProfile,
    current.systemPrompt, JSON.stringify(request), wire.url.href, wire.body, String(cap)].join("\0")).digest("hex");
  expect(current.key).toBe(key);
  expect(current.requestDigest).toBe(sha(JSON.stringify([wire.url.href, wire.body])));
  expect(resolveSemanticProposalRevisionParent(f.child, f.child.items[0], cap)).toEqual(f.parentLine);
  expect(f.revision.parent_request_json).toBe(JSON.stringify(f.parentLine.request));
  expect(f.revision.previous_response).toBe(rejectedBody(presentation));
  expect(f.revision.previous_response_sha256).toBe(sha(rejectedBody(presentation)));
  expect(f.revision.instruction).toBe("Review the unchanged original question and approved context against the complete retained previous response. The previous proposal may omit a requested restriction. Return one complete new proposal, not a patch. Do not use source facts or an evaluator answer. The host will apply unchanged admission; previous failures remain retained.");
  expect(f.revision.review_comments).toEqual([]);
  expect(f.revision).not.toHaveProperty("attention_request_sha256");
  expect(JSON.stringify({ child: f.child, view: f.view })).toBe(before);
  expect(current.userPrompt).not.toContain("observer-authored");
  expect(() => prepareRetainedSemanticProposalRevision({ workset: f.child, parentCacheRoot: f.parentRoot,
    maxOutputTokens: cap, itemIndex: 0 })).toThrow(/unrevised original item/u);
});

it.each(presentations)("binds appended %s observations to the actual native wire/quote, then fills, summarizes and reads the child", async presentation => {
  const f = await fixture(presentation), defaultLine = materializeSemanticProposalLines(f.child, cap)[0]!;
  const parentPaths = [artifacts.semanticProposalShardPath(f.parentRoot, f.parentLine.key),
    providerRawAttemptPath(f.parentRoot, f.parentLine.key, 1),
    ledgerPath(f.parentRoot, semanticProposalLookup(f.workset, f.parentLine, cap).attempt_lineage_digest!)];
  const parentBytes = parentPaths.map(path => readFileSync(path));
  expect(f.line.request).toEqual(defaultLine.request);
  expect(f.line.userPrompt).toBe(defaultLine.userPrompt);
  expect(f.line.responseJsonSchema).toEqual(defaultLine.responseJsonSchema);
  expect(f.line.systemPrompt.startsWith(defaultLine.systemPrompt + "\n\nAPP-PRIVATE EXPERIMENT:")).toBe(true);
  expect(f.line.systemPrompt).toContain("fallible, may be wrong");
  expect(f.line.systemPrompt).toContain(f.view.observations[0]!.text);
  expect(f.line.key).not.toBe(defaultLine.key);
  expect(f.line.requestDigest).not.toBe(defaultLine.requestDigest);
  const inventory = semanticProposalCacheInputPaths(f.child, f.childRoot, cap, true, f.view);
  expect(inventory).toContain(artifacts.semanticProposalShardPath(f.childRoot, f.line.key));
  expect(inventory).toContain(parentPaths[0]);
  const preflight = f.prepare();
  expect(preflight).toMatchObject({ keys: [f.line.key], maximum_attempts: 1, provider_calls: 0,
    maximum_input_tokens_per_attempt: f.line.inputByteUpper, quote_basis: basis });
  expect(preflight.maximum_input_tokens_per_attempt).toBeGreaterThan(defaultLine.inputByteUpper);
  const authority = f.bind();
  const expectedUsd = (f.line.inputByteUpper * rates.inputUsdPerMillion + cap * rates.outputUsdPerMillion) / 1_000_000;
  expect(authority.price.estimated_upper_usd).toBe(expectedUsd);
  f.setBody();
  const callerView = structuredClone(f.view);
  const result = await executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority, config,
    queryRevisionObserverView: callerView, extractor: { extract: async request => {
      // The in-flight caller cannot change the captured identity used by summary/readback.
      (callerView.observations[0] as { text: string }).text = "Changed after capture.";
      return f.extractor.extract(request);
    } } });
  expect(result).toMatchObject({ interpreted: 1, newly_admitted: 1, attempts: 1, unattempted: 0 });
  expect(f.wires).toHaveLength(2);
  const sent = JSON.parse(f.wires[1]!.body);
  expect(sent.messages[0].content).toBe(f.line.systemPrompt);
  expect(sent.messages[1].content).toBe(defaultLine.userPrompt);
  expect(sent.response_format.json_schema.schema).toEqual(defaultLine.responseJsonSchema);
  expect(f.line.requestDigest).toBe(sha(JSON.stringify(["https://api.stepfun.com/step_plan/v1/chat/completions", f.wires[1]!.body])));
  expect(f.line.inputByteUpper).toBe(Buffer.byteLength(f.wires[1]!.body, "utf8") + 256);
  const meter = new SourceSemanticResourceLedger({ work_units: 100_000_000, memory_bytes: 100_000_000 });
  expect(f.read(f.view, meter)).toMatchObject({ status: "interpreted", shard: {
    cache_key: f.line.key, system_prompt: f.line.systemPrompt, user_prompt: defaultLine.userPrompt, raw_json: f.completeBody } });
  expect(meter.spentBytes).toBeGreaterThan(Buffer.byteLength(f.line.systemPrompt));
  expect(readProviderRawAttempt(f.childRoot, f.line.key, 1)).toMatchObject({ full_replay_possible: true,
    decoded_text: f.completeBody, usage_known: true, usage: { inputTokens: 17, outputTokens: 12, totalTokens: 29 } });
  expect(openSemanticProposalAttemptLedger({ cacheRoot: f.childRoot, authority, kind: "query" }).snapshot())
    .toMatchObject({ attempts: 1, unresolvedAttempts: [], successfulShards: 1, telemetry: { totalTokens: 29 } });
  expect(parentPaths.map(path => readFileSync(path))).toEqual(parentBytes);
  expect(await executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority,
    config: { ...config, apiKey: null }, queryRevisionObserverView: f.view })).toMatchObject({ interpreted: 1, attempts: 0, cache_hits: 1 });
  expect(f.wires).toHaveLength(2);
  const cachedPreflight = f.prepare();
  expect(cachedPreflight).toMatchObject({ keys: [], maximum_attempts: 0, missing: 0 });
  const cachedAuthority = pinSemanticProposalAuthority({ preflight: cachedPreflight, ...rates });
  expect(await executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority: cachedAuthority,
    config: { ...config, apiKey: null }, queryRevisionObserverView: f.view }))
    .toMatchObject({ interpreted: 1, attempts: 0, cache_hits: 1 });
  expect(f.wires).toHaveLength(2);
});

it("recovers the actual complete retained child raw only with its frozen view and original grant, without another transport", async () => {
  const f = await fixture(), authority = f.bind(); f.setBody();
  const publish = vi.spyOn(artifacts, "writeSemanticProposalShard").mockImplementationOnce(() => {
    throw new Error("fixture crash after retained raw");
  });
  await expect(executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority, config,
    extractor: f.extractor, queryRevisionObserverView: f.view })).rejects.toThrow(/fixture crash/u);
  publish.mockRestore();
  expect(f.wires).toHaveLength(2);
  const rawPath = providerRawAttemptPath(f.childRoot, f.line.key, 1), rawBytes = readFileSync(rawPath);
  const ledger = ledgerPath(f.childRoot, authority.attempt_lineage_digest), reserved = readFileSync(ledger);
  expect(f.read().status).toBe("pending");
  // Raw-only pending state is not a cached shard; preparation remains read-only and does not settle it.
  expect(f.prepare()).toMatchObject({ provider_calls: 0, missing: 1, keys: [f.line.key] });
  expect(readFileSync(ledger)).toEqual(reserved);
  const wrong = captureQueryRevisionObserverView({ ...f.view, observations: [{ ...f.view.observations[0], text: "Different observation." }] });
  const trap = { extract: vi.fn(async () => { throw new Error("recovery must not dispatch"); }) };
  await expect(executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority,
    config: { ...config, apiKey: null }, extractor: trap, queryRevisionObserverView: wrong }))
    .rejects.toThrow(/observer view differs from authorized request keys/u);
  // Omission selects the unchanged default identity, not an implicit discovery of the runtime treatment.
  expect(await executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority,
    config: { ...config, apiKey: null }, extractor: trap }))
    .toMatchObject({ interpreted: 0, attempts: 0, unattempted: 1, pending: 0 });
  expect(readFileSync(ledger)).toEqual(reserved);
  expect(readFileSync(rawPath)).toEqual(rawBytes);
  // Readback has no grant: a different valid view is a local key miss, never evidence of global unusedness/recovery.
  expect(f.read(wrong).status).toBe("unattempted");
  expect(readSemanticProposalResults(f.child, f.childRoot, cap)[0]?.status).toBe("unattempted");
  expect(await executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority,
    config: { ...config, apiKey: null }, extractor: trap, queryRevisionObserverView: f.view }))
    .toMatchObject({ interpreted: 1, pending: 0, unattempted: 0, newly_admitted: 1 });
  expect(f.read().status).toBe("interpreted");
  expect(trap.extract).not.toHaveBeenCalled();
  expect(f.wires).toHaveLength(2);
  expect(readFileSync(rawPath)).toEqual(rawBytes);
});

it("rejects invalid hashes, locations, provenance/kinds and bounds before attempts or transport", async () => {
  const f = await fixture(), authority = f.bind(), badHash = "a".repeat(64);
  const observation = f.view.observations[0]!;
  const changedLocation = (document: string, pointer: string) => ({ ...f.view,
    observations: [{ ...observation, locations: [{ document, pointer }] }] });
  const invalid = [
    ...["parent_key", "parent_request_digest", "parent_request_sha256", "previous_response_sha256"].map(field => ({ ...f.view, [field]: badHash })),
    changedLocation("previous_response", "/query/nodes/99/arguments/1/excerpt"),
    changedLocation("previous_response", "/query/nodes/00"), changedLocation("previous_response", "/query/nodes/-1"),
    changedLocation("previous_response", "/query/nodes/~2"), changedLocation("parent_request", "/approved_fixed_context"),
    changedLocation("native_core", "/error/reason"), { ...f.view, kind: "native-core-diagnostics" },
    { ...f.view, observations: [{ ...observation, provenance: "" }] },
    { ...f.view, observations: Array(9).fill(observation) },
    { ...f.view, observations: [{ ...observation, text: "x".repeat(1025) }] },
    { ...f.view, observations: Array(8).fill({ ...observation, text: "é".repeat(1024), provenance: "é".repeat(256) }) }
  ];
  const trap = { extract: vi.fn(async () => { throw new Error("must not dispatch"); }) };
  for (const value of invalid) {
    const selected = value as QueryRevisionObserverView;
    expect(() => materializeSemanticProposalLines(f.child, cap, undefined, selected)).toThrow();
    expect(() => f.prepare(selected)).toThrow();
    expect(() => f.read(selected)).toThrow();
    await expect(executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority,
      config, extractor: trap, queryRevisionObserverView: selected })).rejects.toThrow();
  }
  expect(existsSync(ledgerPath(f.childRoot, authority.attempt_lineage_digest))).toBe(false);
  expect(existsSync(providerRawAttemptPath(f.childRoot, f.line.key, 1))).toBe(false);
  expect(trap.extract).not.toHaveBeenCalled(); expect(f.wires).toHaveLength(1);
});

it("captures/deep-freezes caller data, validates exact JSON pointers without classifying the observations, and refuses other revisions/roles", async () => {
  const f = await fixture(), offered = structuredClone(f.view), snapshot = JSON.stringify(offered);
  const captured = captureQueryRevisionObserverView(offered);
  expect(JSON.stringify(offered)).toBe(snapshot);
  expect(captured).not.toBe(offered);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Object.isFrozen(captured.observations)).toBe(true);
  expect(Object.isFrozen(captured.observations[0]!.locations[0])).toBe(true);
  const changed = captureQueryRevisionObserverView({ ...offered, observations: [{ ...offered.observations[0],
    locations: [{ document: "parent_request", pointer: "/original_query" }, ...offered.observations[0]!.locations],
    text: "This observer statement may be mistaken." }] });
  expect(materializeSemanticProposalLines(f.child, cap, undefined, changed)[0]!.key).not.toBe(f.line.key);
  for (const child of [f.workset, { ...f.child, kind: "semantic_correspondence" as const },
    { ...f.child, items: [...f.child.items, ...f.child.items] }]) {
    expect(() => materializeSemanticProposalLines(child, cap, undefined, captured)).toThrow();
  }
  for (const revision of [{ ...f.revision, revision_number: 2 }, { ...f.revision, kind: "semantic_correspondence" },
    { ...f.revision, review_comments: ["observer text"] }, { ...f.revision, attention_request_sha256: f.revision.base_request_sha256 }]) {
    expect(() => materializeSemanticProposalLines({ ...f.child, items: [{
      ...(f.child.items[0] as object), revision }] }, cap, undefined, captured)).toThrow();
  }
});

async function cachedDefaultRevisionFixture() {
  const root = mkdtempSync(join(tmpdir(), "default-query-revision-grant-")); roots.push(root);
  const parentRoot = join(root, "parent"), childRoot = join(root, "child");
  const localConfig = { providerUrl: "http://127.0.0.1:9", model: "gemini-3.1-flash-lite",
    requestProfile: "gemini-3.1-minimal-v1" as const, apiKey: null };
  const parent = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
    model: localConfig.model, request_profile: localConfig.requestProfile, provider_url: localConfig.providerUrl,
    items: presentations.map(generation_presentation => ({ original_query: MIRA_QUERY, generation_presentation })) });
  const fixtureExtractor = { extract: vi.fn(async (input: { userPrompt: string }) => {
    const request = JSON.parse(input.userPrompt);
    const rawJson = request.contract === "source-semantic-query-request-v10" ? nestedMeaningBody() : meaningBody("sample");
    const usage = { inputTokens: 3, outputTokens: 5, totalTokens: 8 };
    return { rawJson, usage, responseMetadata: { finishReason: "STOP" }, responseBody: syntheticGeminiBody(rawJson, "STOP", usage) };
  }) };
  const pin = (workset: typeof parent, cacheRoot: string) => pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(workset, cacheRoot, 128, 1), inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  await executeSemanticProposalFill({ workset: parent, cacheRoot: parentRoot, authority: pin(parent, parentRoot),
    config: localConfig, extractor: fixtureExtractor });
  const child = parseSemanticProposalWorkset({ ...parent, revision_parent_cache_root: parentRoot,
    items: parent.items.map((item, itemIndex) => ({ ...(item as object), revision: prepareRetainedSemanticProposalRevision({
      workset: parent, parentCacheRoot: parentRoot, maxOutputTokens: 128, itemIndex }) })) });
  const firstOnly = { ...child, items: [child.items[0]] };
  const firstAuthority = pin(firstOnly, childRoot);
  await executeSemanticProposalFill({ workset: firstOnly, cacheRoot: childRoot, authority: firstAuthority,
    config: localConfig, extractor: fixtureExtractor });
  return { child, firstOnly, childRoot, localConfig, pin, firstAuthority };
}

it("reuses a default cached Q revision with its zero-key cached grant without requiring a runtime view", async () => {
  const f = await cachedDefaultRevisionFixture(), cachedAuthority = f.pin(f.firstOnly, f.childRoot);
  expect(cachedAuthority.keys).toEqual([]);
  const ledger = ledgerPath(f.childRoot, f.firstAuthority.attempt_lineage_digest), before = readFileSync(ledger);
  const trap = { extract: vi.fn(async () => { throw new Error("cached default must not dispatch"); }) };
  expect(await executeSemanticProposalFill({ workset: f.firstOnly, cacheRoot: f.childRoot, authority: cachedAuthority,
    config: f.localConfig, extractor: trap })).toMatchObject({ interpreted: 1, cache_hits: 1, attempts: 0 });
  expect(trap.extract).not.toHaveBeenCalled();
  expect(readFileSync(ledger)).toEqual(before);
});

it("keeps cached default revisions outside the dispatch grant and leaves cumulative attempt ceilings to the existing owner", async () => {
  const f = await cachedDefaultRevisionFixture(), partialAuthority = f.pin(f.child, f.childRoot);
  const cachedKey = f.firstAuthority.keys[0]!;
  expect(partialAuthority.keys).toHaveLength(1);
  expect(partialAuthority.keys).not.toContain(cachedKey);
  expect(readSemanticProposalResults(f.child, f.childRoot, 128).map(row => row.status)).toEqual(["interpreted", "unattempted"]);
  const ledger = ledgerPath(f.childRoot, f.firstAuthority.attempt_lineage_digest), before = readFileSync(ledger);
  const trap = { extract: vi.fn(async () => { throw new Error("a new receipt must not renew the spent cumulative ceiling"); }) };
  expect(await executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority: partialAuthority,
    config: f.localConfig, extractor: trap })).toMatchObject({ interpreted: 1, cache_hits: 1, attempts: 0, unattempted: 1 });
  expect(trap.extract).not.toHaveBeenCalled();
  expect(readFileSync(ledger)).toEqual(before);
});

it.each(presentations)("rejects a cached interpreted %s observer view under a nonempty grant for a different view without dispatch or ledger consumption", async presentation => {
  const f = await fixture(presentation), authority = f.bind(); f.setBody();
  expect(await executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority, config,
    extractor: f.extractor, queryRevisionObserverView: f.view })).toMatchObject({ interpreted: 1, attempts: 1 });
  const preserved = [artifacts.semanticProposalShardPath(f.childRoot, f.line.key),
    providerRawAttemptPath(f.childRoot, f.line.key, 1),
    ledgerPath(f.childRoot, authority.attempt_lineage_digest)];
  const before = preserved.map(path => readFileSync(path));
  const other = captureQueryRevisionObserverView({ ...f.view, observations: [{ ...f.view.observations[0]!,
    text: "Different observation." }] });
  const grantB = pinSemanticProposalAuthority({ preflight: f.prepare(other), ...rates });
  expect(grantB.keys).toHaveLength(1);
  expect(grantB.keys).not.toContain(f.line.key);
  const trap = { extract: vi.fn(async () => { throw new Error("mismatched grant must not dispatch"); }) };
  await expect(executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority: grantB,
    config: { ...config, apiKey: null }, extractor: trap, queryRevisionObserverView: f.view }))
    .rejects.toThrow(/observer view differs from authorized request keys/u);
  expect(trap.extract).not.toHaveBeenCalled();
  expect(f.wires).toHaveLength(2);
  expect(preserved.map(path => readFileSync(path))).toEqual(before);
  expect(f.read()).toMatchObject({ status: "interpreted", shard: { cache_key: f.line.key, raw_json: f.completeBody } });
});

it.each(presentations)("rejects a cached terminal-rejected %s observer view under a nonempty grant for a different view without dispatch or ledger consumption", async presentation => {
  const f = await fixture(presentation), authority = f.bind();
  const fill = executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority, config,
    extractor: f.extractor, queryRevisionObserverView: f.view });
  if (presentation === "nested-meaning-v1") await expect(fill).rejects.toThrow(/stopped after terminal/u);
  else await expect(fill).resolves.toMatchObject({ rejected: 1, newly_admitted: 0 });
  expect(f.read()).toMatchObject({ status: presentation === "nested-meaning-v1" ? "invalid" : "core_rejected",
    shard: { cache_key: f.line.key, raw_json: rejectedBody(presentation), admitted: false } });
  const preserved = [artifacts.semanticProposalShardPath(f.childRoot, f.line.key),
    providerRawAttemptPath(f.childRoot, f.line.key, 1),
    ledgerPath(f.childRoot, authority.attempt_lineage_digest)];
  const before = preserved.map(path => readFileSync(path));
  const other = captureQueryRevisionObserverView({ ...f.view, observations: [{ ...f.view.observations[0]!,
    text: "Different observation." }] });
  const grantB = pinSemanticProposalAuthority({ preflight: f.prepare(other), ...rates });
  expect(grantB.keys).toHaveLength(1);
  expect(grantB.keys).not.toContain(f.line.key);
  const trap = { extract: vi.fn(async () => { throw new Error("mismatched grant must not dispatch"); }) };
  await expect(executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority: grantB,
    config: { ...config, apiKey: null }, extractor: trap, queryRevisionObserverView: f.view }))
    .rejects.toThrow(/observer view differs from authorized request keys/u);
  expect(trap.extract).not.toHaveBeenCalled();
  expect(f.wires).toHaveLength(2);
  expect(preserved.map(path => readFileSync(path))).toEqual(before);
  expect(f.read()).toMatchObject({ status: presentation === "nested-meaning-v1" ? "invalid" : "core_rejected",
    shard: { cache_key: f.line.key, raw_json: rejectedBody(presentation), admitted: false } });
});

it.each(presentations)("does not repair or weaken native rejection of the same %s mechanical error in a child", async presentation => {
  const f = await fixture(presentation), authority = f.bind();
  const fill = executeSemanticProposalFill({ workset: f.child, cacheRoot: f.childRoot, authority, config,
    extractor: f.extractor, queryRevisionObserverView: f.view });
  if (presentation === "nested-meaning-v1") await expect(fill).rejects.toThrow(/stopped after terminal/u);
  else await expect(fill).resolves.toMatchObject({ rejected: 1, newly_admitted: 0 });
  expect(f.read()).toMatchObject({ status: presentation === "nested-meaning-v1" ? "invalid" : "core_rejected",
    shard: { raw_json: rejectedBody(presentation), admitted: false } });
  expect(f.wires).toHaveLength(2);
});
