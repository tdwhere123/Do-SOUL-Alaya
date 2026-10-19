import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const [{ default: fs }, { default: fsp }, { syncBuiltinESMExports }] =
    await Promise.all([import("node:fs"), import("node:fs/promises"), import("node:module")]);
  const restores: (() => void)[] = [], forbidden: string[] = [];
  const deny = (kind: string) => { forbidden.push(kind); throw new Error(`Provider-free source test forbids ${kind}`); };
  for (const name of ["node:http", "node:https", "node:net", "node:tls", "node:http2", "node:dgram"]) {
    const owner = (await import(name)).default;
    for (const key of ["request", "get", "connect", "createConnection", "createSocket"]) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (typeof descriptor?.value !== "function") continue;
      Object.defineProperty(owner, key, { ...descriptor, value: () => deny(name) });
      restores.push(() => Object.defineProperty(owner, key, descriptor));
    }
  }
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = () => deny("fetch");
  restores.push(() => { globalThis.fetch = nativeFetch; });
  const environment = process.env;
  const guardedEnvironment = Object.fromEntries(Object.keys(environment)
    .filter(key => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)).map(key => [key, environment[key]]));
  // Native daemon fixtures may set their own local authentication after real credentials are removed.
  process.env = guardedEnvironment;
  restores.push(() => { process.env = environment; });
  for (const owner of [fs, fsp]) for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (typeof descriptor?.value !== "function") continue;
    Object.defineProperty(owner, key, { ...descriptor, value: new Proxy(descriptor.value, {
      apply(target, receiver, args) {
        const filename = String(args[0]);
        const nativeFixtureConfig = /[/\\]alaya-bench-config-[a-f0-9-]+[/\\]\.env(?:\.[a-f0-9-]+\.tmp)?$/u.test(filename);
        if (!nativeFixtureConfig && /(?:^|[/\\])(?:[^/\\]+\.env|\.env(?:\.[^/\\]+)?|\.aws|\.azure|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(filename)) return deny(`credential file ${filename}`);
        return Reflect.apply(target, receiver, args);
      }
    }) });
    restores.push(() => Object.defineProperty(owner, key, descriptor));
  }
  process.env.ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST = "0";
  process.env.OFFICIAL_API_GARDEN_PROVIDER_URL = "https://fixture-provider.invalid/v1";
  syncBuiltinESMExports();
  return { forbidden, restore: () => { for (const restore of restores.reverse()) restore(); syncBuiltinESMExports(); } };
});
afterAll(() => { isolation.restore(); expect(isolation.forbidden).toEqual([]); });

vi.mock("../../../runs/extraction/authority/inspection.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../runs/extraction/authority/inspection.js")>();
  return { ...actual, inspectExtractionAuthority: vi.fn(actual.inspectExtractionAuthority) };
});
import { parseFlags } from "../../../cli/cli-options.js";
import { runCli } from "../../../cli/cli.js";
import { runExtractionFillCommand } from "../../../cli/extraction-fill/command-core.js";
import { readExtractionGeneration } from "../../../cli/extraction-fill/packet-profile.js";
import { runAuthorizeExtractionCommand } from "../../../cli/extraction-authority/command.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, parseSourceSemanticRequestLine } from "../../../runs/extraction/request-artifact.js";
import { preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { sourceSemanticInteractiveWireSha256 } from "../../../runs/extraction/fill/source-semantic-interactive-request.js";
import { inspectExtractionAuthority } from "../../../runs/extraction/authority/inspection.js";
import { loadExtractionAuthority } from "../../../runs/extraction/fill/execution/receipt-bound-authority.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import * as soul from "@do-soul/alaya-soul";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { openReadOnlyDatabase } from "@do-soul/alaya-storage";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { prepareSourceSemanticRequestWire } from "../../../runs/extraction/fill/source-semantic-interactive-request.js";
import { prepareSourcePublicationAssociations } from "../../../runs/snapshot/source-records/prepare-associations.js";
import { publishSourceSemanticSnapshot } from "../../../runs/snapshot/source-records/publish.js";
import { tableCompletedResponse } from "../../longmemeval/extraction-fill/source-semantic-table-response.test-support.js";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "../../longmemeval/extraction-fill/fixture.js";

const TASK = { contract: "source-semantic-generation-task-v1" as const,
  context: "complete_original_source" as const, original_query: "  What about cli-task?  ",
  responsibility: { kind: "original_query_task" as const, other_meaning: "unassessed" as const } };
let roots: { cacheRoot: string; dataDir: string; pinnedMetaRoot: string };
const writeDataset = registerExtractionFillHooks(value => { roots = value; }, "longmemeval_s");
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function scenario() {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "step-3.5-flash-2603");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "step-3.5-2603-low-json-schema-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  await writeDataset([buildExtractionFillQuestion("cli-task", "I completed alpha.", "I completed decoy.")]);
  const taskPath = join(roots.cacheRoot, "task.json"), reportPath = join(roots.cacheRoot, "preflight.json");
  writeFileSync(taskPath, JSON.stringify(TASK));
  const args = ["--variant", "s", "--offset", "0", "--limit", "1", "--data-dir", roots.dataDir,
    "--pinned-meta-root", roots.pinnedMetaRoot, "--extraction-cache-root", roots.cacheRoot,
    "--extraction-source-packing", "complete-source", "--extraction-open-semantics", "--generation-task-json", taskPath];
  const direct = await preflightSourceSemanticInteractive({ ...roots, variant: "longmemeval_s", offset: 0, limit: 1,
    sourcePacking: "complete-source", openSemantics: { ...EXTRACTION_OPEN_SEMANTICS_GENERATION, generation_task: TASK } });
  expect(await runCli(["extraction-fill", ...args, "--extraction-preflight-out", reportPath])).toBe(0);
  return { args, taskPath, reportPath, direct, report: JSON.parse(readFileSync(reportPath, "utf8")) as typeof direct };
}

it("writes the direct API's exact task-bearing native H, request line, wire digest and quote through the CLI", async () => {
  const { args, direct, report } = await scenario();
  expect(report).toEqual(direct);
  expect(readExtractionGeneration(parseFlags(args)).openSemantics?.generation_task).toEqual(TASK);
  expect(report.planned_requests.length).toBeGreaterThan(0);
  for (const line of report.planned_requests) {
    const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
    expect(request.source_request.generation_task).toEqual(TASK);
    expect(request.source_request.original_source).toContain("I completed");
    expect(line.request_digest).toBe(sourceSemanticInteractiveWireSha256(
      { ...report.config, openSemantics: { ...EXTRACTION_OPEN_SEMANTICS_GENERATION, generation_task: TASK } }, line, report.max_output_tokens));
  }
  expect(report.provider_calls).toBe(0);
});

it("passes the same task through native authority and receipt-bound execution inspection and rejects changed tasks", async () => {
  const { args, taskPath, reportPath, report } = await scenario();
  setExtractionCredentialFixture();
  const keysPath = join(roots.cacheRoot, "keys.json"), receiptPath = join(roots.cacheRoot, "authority.json");
  writeFileSync(keysPath, JSON.stringify(report.selected_keys));
  const authorityArgs = [...args, "--extraction-action", "sample", "--extraction-sample-keys", keysPath,
    "--extraction-source-preflight", reportPath, "--extraction-receipt-out", receiptPath,
    "--extraction-output-token-cap", String(report.max_output_tokens), "--extraction-output-token-field", "max_tokens",
    "--extraction-input-price-usd-per-million", String(report.quote_basis.input_usd_equivalent_per_million),
    "--extraction-output-price-usd-per-million", String(report.quote_basis.output_usd_equivalent_per_million),
    "--extraction-max-input-tokens", String(report.maximum_input_tokens_per_attempt), "--extraction-disk-floor-bytes", "0"];
  expect(await runAuthorizeExtractionCommand(authorityArgs)).toBe(0);
  expect(inspectExtractionAuthority).toHaveBeenCalledWith(expect.objectContaining({
    openSemantics: expect.objectContaining({ generation_task: TASK }), action: "sample" }));
  const nativeLoad = vi.fn(async (input: Parameters<typeof loadExtractionAuthority>[0]) => {
    await loadExtractionAuthority(input, roots.cacheRoot);
    throw new Error("receipt inspected without provider execution");
  });
  const executionFlags = parseFlags([...args, "--extraction-authority", receiptPath, "--concurrency", "1"]);
  vi.mocked(inspectExtractionAuthority).mockClear();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(await runExtractionFillCommand(executionFlags, { runExtractionFill: nativeLoad, signalSource: process })).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("receipt inspected without provider execution"));
  expect(inspectExtractionAuthority).toHaveBeenCalledWith(expect.objectContaining({
    openSemantics: expect.objectContaining({ generation_task: TASK }), action: "sample" }));
  const changedTask = { ...TASK, original_query: TASK.original_query.trim() };
  writeFileSync(taskPath, JSON.stringify(changedTask));
  const changedGeneration = readExtractionGeneration(parseFlags(args)).openSemantics!;
  expect(() => parseSourceSemanticRequestLine(report.ready_requests[0], { ...report.config, openSemantics: changedGeneration })).toThrow();
  const changed = await preflightSourceSemanticInteractive({ ...roots, variant: "longmemeval_s", offset: 0, limit: 1,
    sourcePacking: "complete-source", openSemantics: changedGeneration });
  expect(changed.selected_keys.some(key => report.selected_keys.includes(key))).toBe(false);
  expect(changed.planned_requests.map(line => line.request_digest)).not.toEqual(report.planned_requests.map(line => line.request_digest));
  expect(await runExtractionFillCommand(executionFlags, { runExtractionFill: nativeLoad, signalSource: process })).toBe(2);
  expect(stderr.mock.calls.at(-1)?.[0]).not.toContain("receipt inspected without provider execution");
  expect(await runAuthorizeExtractionCommand(authorityArgs)).toBe(2);
});

async function exhaustivePreparation() {
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "step-3.5-flash-2603");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "step-3.5-2603-low-json-schema-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  await writeDataset([buildExtractionFillQuestion("exhaustive", "I completed alpha.", "I completed decoy.")]);
  const generationTask = { ...TASK, responsibility: { kind: "all_supplied_meaning" as const } };
  const openSemantics = { ...EXTRACTION_OPEN_SEMANTICS_GENERATION, generation_task: generationTask,
    generation_view_contract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT };
  const options = { ...roots, variant: "longmemeval_s" as const, offset: 0, limit: 1,
    sourcePacking: "complete-source" as const, openSemantics };
  const inspection = await inspectExtractionAuthority({ ...options, action: "sample", revision: readCurrentExtractionAuthorityRevision() });
  const preflight = await preflightSourceSemanticInteractive({ ...options, preflightKeys: inspection.missingKeys });
  const receipt = createExtractionAuthorityReceipt({ action: "sample", inspection, observation: inspection.observation,
    sampleScope: createExtractionSampleScope(inspection.missingKeys, inspection), sourcePreflight: preflight,
    maxConcurrency: 1, outputTokenCap: { field: "max_tokens", value: preflight.max_output_tokens }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: preflight.quote_basis.input_usd_equivalent_per_million,
      outputUsdPerMillion: preflight.quote_basis.output_usd_equivalent_per_million,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const authorityReceiptPath = join(roots.cacheRoot, "exhaustive-authority.json");
  writeExtractionAuthorityReceipt(authorityReceiptPath, receipt);
  return { options: { ...options, authorityReceiptPath, concurrency: 1 }, preflight, generationTask };
}

it("refuses old exhaustive view authority at receipt-bound execution even with unchanged host requests", async () => {
  const nativeInput = soul.sourceSemanticGenerationInput, nativePresentation = soul.sourceSemanticGenerationPresentation;
  const oldInput = (host: soul.SourceSemanticRequest) => {
    const projected = JSON.parse(nativeInput(host));
    projected.source_request.generation_task = host.source_request.generation_task;
    return JSON.stringify(projected);
  };
  const inputSpy = vi.spyOn(soul, "sourceSemanticGenerationInput").mockImplementation(oldInput);
  const presentationSpy = vi.spyOn(soul, "sourceSemanticGenerationPresentation").mockImplementation(json => {
    const presentation = nativePresentation(json);
    return presentation === undefined ? undefined : { ...presentation,
      modelInputJson: oldInput(soul.parseSourceSemanticRequest(JSON.parse(json))) };
  });
  const fixture = await exhaustivePreparation();
  await expect(loadExtractionAuthority(fixture.options, roots.cacheRoot)).resolves.toHaveProperty("receipt");
  inputSpy.mockRestore(); presentationSpy.mockRestore();
  const { authorityReceiptPath: _authority, ...preflightOptions } = fixture.options;
  const current = await preflightSourceSemanticInteractive(preflightOptions);
  expect(current.ready_requests.map(line => line.userPrompt)).toEqual(fixture.preflight.ready_requests.map(line => line.userPrompt));
  expect(current.ready_requests.map(line => line.requestSha256)).toEqual(fixture.preflight.ready_requests.map(line => line.requestSha256));
  expect(current.selected_keys).not.toEqual(fixture.preflight.selected_keys);
  expect(current.planned_requests.map(line => line.request_digest)).not.toEqual(fixture.preflight.planned_requests.map(line => line.request_digest));
  await expect(loadExtractionAuthority(fixture.options, roots.cacheRoot)).rejects.toThrow(/changed|differ|outside|mismatch|identity/u);
});

it("retains the complete exhaustive host task through serialized native receive, cache reopen and SQLite publication", async () => {
  const fixture = await exhaustivePreparation();
  setExtractionCredentialFixture();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), view = JSON.parse(body.messages[1].content);
    expect(view.source_request.generation_task).toEqual({ contract: "source-semantic-generation-task-v1",
      context: "complete_original_source", responsibility: { kind: "all_supplied_meaning" } });
    const line = fixture.preflight.ready_requests.find(line =>
      JSON.parse(line.userPrompt).source_request.original_source === view.source_request.original_source)!;
    expect(line).toBeDefined();
    expect(String(init?.body)).toBe(prepareSourceSemanticRequestWire({ ...fixture.preflight.config,
      openSemantics: fixture.options.openSemantics }, line, fixture.preflight.max_output_tokens).body);
    const host = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
    expect(host.source_request.generation_task).toEqual(fixture.generationTask);
    expect(view.source_request.source_assertions).toEqual(host.source_request.source_assertions);
    expect(view.source_request.attribution_context).toEqual(host.source_request.attribution_context);
    expect(view.response_schema).toEqual(soul.sourceSemanticResponseJsonSchema(host));
    const assertion = view.source_request.source_assertions.find((unit: { text: string }) => unit.text.includes("completed"));
    const raw = tableCompletedResponse(assertion.assertion_id, assertion.text.includes("alpha") ? "alpha" : "decoy");
    return Response.json({ choices: [{ message: { content: JSON.stringify(raw) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
  });
  vi.stubGlobal("fetch", fetch);
  expect((await runExtractionFill(fixture.options)).newlyExtracted).toBe(fixture.preflight.selected_requests);
  for (const line of fixture.preflight.ready_requests) {
    const cached = inspectCachedSourceSemantic(roots.cacheRoot, line.key, fixture.preflight.config.model, fixture.preflight.config.requestProfile);
    expect(cached.status).toBe("hit"); if (cached.status !== "hit") throw new Error("native exhaustive cache required");
    expect(cached.admitted.draft?.generation_task).toEqual(fixture.generationTask);
    expect(cached.admitted.interpretation?.generation_task).toEqual(fixture.generationTask);
  }
  const retainedPreparationPath = join(roots.cacheRoot, "exhaustive-preflight.json");
  writeFileSync(retainedPreparationPath, JSON.stringify(fixture.preflight));
  const population = { name: "longmemeval_s", dataDir: roots.dataDir, pinnedMetaRoot: roots.pinnedMetaRoot,
    model: fixture.preflight.config.model, requestProfile: fixture.preflight.config.requestProfile,
    openSemantics: fixture.options.openSemantics };
  const associations = await prepareSourcePublicationAssociations(population,
    [{ cacheRoot: roots.cacheRoot, retainedPreparationPath }], join(roots.cacheRoot, "associations.json"));
  const snapshotPath = join(roots.cacheRoot, "published.sqlite");
  const published = await publishSourceSemanticSnapshot({ snapshotPath, dataDirRoot: join(roots.cacheRoot, "publish-daemon"),
    recordedAt: "2026-09-25T00:00:00.000Z", workspaceId: "exhaustive", runId: "exhaustive", producerCommit: "0".repeat(40),
    populations: [{ ...population, cacheRoots: [roots.cacheRoot], publicationAssociations: associations.publicationAssociations }] });
  expect(published.published_count).toBe(fixture.preflight.selected_requests);
  const db = openReadOnlyDatabase(snapshotPath);
  try {
    const rows = db.connection.prepare("SELECT gist FROM evidence_capsules").all() as { gist: string }[];
    expect(rows.filter(row => row.gist.includes(JSON.stringify(fixture.generationTask)))).toHaveLength(published.published_count);
  } finally { db.close(); }
  expect(fetch).toHaveBeenCalledTimes(fixture.preflight.selected_requests);
}, 60_000);

it("rejects malformed task files, absent open semantics, packet mode and incompatible packing", async () => {
  const { taskPath } = await scenario();
  expect(() => readExtractionGeneration(parseFlags(["--generation-task-json", taskPath]))).toThrow(/requires explicit open semantics/u);
  expect(() => readExtractionGeneration(parseFlags(["--extraction-open-semantics", "--extraction-packet-profile", "unused", "--generation-task-json", taskPath]))).toThrow(/mutually exclusive/u);
  expect(() => parseFlags(["--generation-task-json", taskPath, `--generation-task-json=${taskPath}`])).toThrow(/only once/u);
  expect(() => parseFlags(["--generation-task-json"])).toThrow();
  expect(await runCli(["fetch-longmemeval", "--generation-task-json", taskPath, "--extraction-open-semantics"])).toBe(2);
  for (const body of ["{", JSON.stringify({ ...TASK, original_query: " " }), JSON.stringify({ ...TASK, responsibility: { kind: "original_query_task", other_meaning: "assessed" } })]) {
    writeFileSync(taskPath, body);
    expect(() => readExtractionGeneration(parseFlags(["--extraction-open-semantics", "--generation-task-json", taskPath]))).toThrow();
  }
  writeFileSync(taskPath, JSON.stringify(TASK));
  await expect(preflightSourceSemanticInteractive({ ...roots, variant: "longmemeval_s", offset: 0, limit: 1,
    sourcePacking: "singleton", ...readExtractionGeneration(parseFlags(["--extraction-open-semantics", "--generation-task-json", taskPath])) })).rejects.toThrow();
});
