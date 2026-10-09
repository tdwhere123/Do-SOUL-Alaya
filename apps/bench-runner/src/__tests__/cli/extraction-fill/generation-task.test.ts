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
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "../../longmemeval/extraction-fill/fixture.js";

const TASK = { contract: "source-semantic-generation-task-v1" as const,
  context: "complete_original_source" as const, original_query: "  What about cli-task?  ",
  responsibility: { kind: "original_query_task" as const, other_meaning: "unassessed" as const } };
let roots: { cacheRoot: string; dataDir: string; pinnedMetaRoot: string };
const writeDataset = registerExtractionFillHooks(value => { roots = value; }, "longmemeval_s");
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

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
