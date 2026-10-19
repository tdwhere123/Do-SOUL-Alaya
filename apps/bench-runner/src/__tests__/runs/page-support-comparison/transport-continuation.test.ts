import { fetchLoopbackProvider } from "../../support/loopback-provider-fetch.js";
import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";
import * as ledgerOwner from "../../../runs/extraction/authority/attempt-ledger.js";
import * as revisionOwner from "../../../runs/extraction/authority/inspection.js";
import { continuationChildClaimPath } from "../../../runs/extraction/authority/continuation/child-claim.js";
import * as rawOwner from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { acquireExtractionCacheWriteLease } from "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import * as resultOwner from "../../../runs/page-support-comparison/persist.js";
import { STEP_OPENAPI_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { PageSupportComparisonAuthoritySchema, pinPageSupportComparisonAuthority } from "../../../runs/page-support-comparison/authority.js";
import { executePageSupportComparisonFill, preparePageSupportComparison, readPageSupportComparisonResults } from "../../../runs/page-support-comparison/execute.js";
import { PAGE_SUPPORT_COMPARISON_WORKSET_CONTRACT, materializePageSupportComparisonLines,
  parsePageSupportComparisonWorkset } from "../../../runs/page-support-comparison/input.js";
import { preparePageSupportComparisonTransportContinuation, quotePageSupportComparisonTransportContinuation,
  pinPageSupportComparisonTransportContinuationAuthority, executePageSupportComparisonTransportContinuationFill,
  readPageSupportComparisonTransportContinuationResults,
  verifyPageSupportComparisonTransportContinuationAuthority } from "../../../runs/page-support-comparison/transport-continuation.js";

const MODEL = STEP_OPENAPI_QUOTE_BASIS.selected_model;
const PROFILE = "step-3.5-2603-low-json-schema-v1" as const;
const TEXT = "Lee left the lab on Tuesday after the sample arrived.";
const CAP = 128;
const roots: string[] = [];
const servers: Server[] = [];
type Response = "failure" | "authentication" | "assessed" | "abstained" | "incomplete" | "invalid";

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("continues the same HTTP request at ordinal two while preserving predecessor bytes and its legacy failure view", async () => {
  const fixture = await failedFixture();
  const retained = predecessorBytes(fixture);
  const preflight = prepare(fixture);
  const line = materializePageSupportComparisonLines(fixture.workset, CAP)[0]!;
  const quote = quotePageSupportComparisonTransportContinuation(preflight, 0.14, 0.42);
  const cny = (line.inputByteUpper * 0.7 + CAP * 2.1) / 1_000_000;
  expect(preflight).toMatchObject({ key: fixture.authority.keys[0], request_digest: line.requestDigest,
    material_digest: line.materialDigest, provider_calls: 0, maximum_attempts: 1,
    cumulative_maximum_attempts: 2, next_attempt_ordinal: 2, max_output_tokens: CAP });
  expect(quote).toMatchObject({ incremental_upper_cny: cny, predecessor_risk_upper_cny: cny,
    cumulative_risk_upper_cny: cny * 2, predecessor_risk_upper_usd: fixture.authority.price.estimated_upper_usd,
    policy_usd_per_cny: 0.20 });
  expect(quote.cumulative_risk_upper_usd).toBe(fixture.authority.price.estimated_upper_usd + quote.incremental_upper_usd);
  expect(rawOwner.readProviderRawAttempt(fixture.cacheRoot, line.key, 1)?.usage_known).toBe(false);
  const authority = pin(preflight);
  expect(authority.keys).toEqual([line.key]);
  expect(authority.limits).toMatchObject({ maximum_attempts: 2, maximum_attempts_per_key: 2,
    incremental_maximum_attempts: 1, next_attempt_ordinal: 2, max_concurrency: 1, max_output_tokens: CAP });
  expect(fixture.authority.limits.maximum_attempts_per_key).toBe(1);
  expect(readNew(fixture, authority)[0]?.status).toBe("unattempted");
  const result = await execute(fixture, authority);
  expect(result).toMatchObject({ attempts: 1, cumulative_attempts: 2, assessed: 1, newly_admitted: 1, status: "assessed" });
  expect(result.row.assessment).toMatchObject({ answer_a: "partial", answer_b: "partial", unresolved: ["Person identity is unknown."] });
  expect(fixture.bodies).toHaveLength(2);
  expect(fixture.bodies[1]).toBe(fixture.bodies[0]);
  expect(fixture.paths).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
  expect(predecessorBytes(fixture)).toEqual(retained);
  expect(readPageSupportComparisonResults(fixture.workset, fixture.cacheRoot, CAP)[0]?.status).toBe("transport_failure");
  const childRaw = rawOwner.readProviderRawAttempt(fixture.cacheRoot, line.key, 2, authority.attempt_lineage_digest);
  expect(childRaw).toMatchObject({ attempt_ordinal: 2, attempt_lineage_digest: authority.attempt_lineage_digest, usage_known: true });
  const resultPath = resultOwner.pageSupportComparisonContinuationResultPath(fixture.cacheRoot, line.key, authority.attempt_lineage_digest);
  const resultBytes = readFileSync(resultPath, "utf8");
  expect(await execute(fixture, authority)).toMatchObject({ attempts: 0, cumulative_attempts: 2, assessed: 1, newly_admitted: 0 });
  expect(await execute(fixture, authority, "recover")).toMatchObject({ attempts: 0, status: "assessed" });
  expect(readFileSync(resultPath, "utf8")).toBe(resultBytes);
  expect(predecessorBytes(fixture)).toEqual(retained);
  expect(fixture.bodies).toHaveLength(2);
  expect(() => prepare(fixture)).toThrow(/already has its one continuation child/u);
  expect(() => PageSupportComparisonAuthoritySchema.parse(authority)).toThrow();
});

it("keeps a second transport failure terminal through reopen without another dispatch or continuation chain", async () => {
  const fixture = await failedFixture(["failure", "failure"]);
  const retained = predecessorBytes(fixture);
  const authority = pin(prepare(fixture));
  expect(await execute(fixture, authority)).toMatchObject({ attempts: 1, cumulative_attempts: 2, terminal_failures: 1, status: "transport_failure" });
  expect(await execute(fixture, authority)).toMatchObject({ attempts: 0, cumulative_attempts: 2, status: "transport_failure" });
  expect(await execute(fixture, authority, "recover")).toMatchObject({ attempts: 0, status: "transport_failure" });
  expect(predecessorBytes(fixture)).toEqual(retained);
  expect(fixture.bodies).toHaveLength(2);
  expect(() => prepare(fixture)).toThrow(/one continuation child/u);
});

it.each(["assessed", "abstained", "incomplete", "invalid"] as const)(
  "does not replay a settled %s semantic outcome as transport continuation", async response => {
    const fixture = await failedFixture([response]);
    expect(() => prepare(fixture)).toThrow(/settled retryable transport failure/u);
    expect(fixture.bodies).toHaveLength(1);
  }
);

it.each([
  { response: "authentication", flag: true }, { response: "failure", flag: false }
] as const)("refuses $response continuation with retained retry flag $flag without rewriting history", async ({ response, flag }) => {
  const fixture = await failedFixture([response]);
  const key = fixture.authority.keys[0]!, rawPath = rawOwner.providerRawAttemptPath(fixture.cacheRoot, key, 1);
  const raw = JSON.parse(readFileSync(rawPath, "utf8"));
  // Author the historical contradictory flag before capturing the immutable fixture history.
  raw.failure_retryable = flag; writeFileSync(rawPath, JSON.stringify(raw));
  const retained = predecessorBytes(fixture);
  expect(() => prepare(fixture)).toThrow(/settled retryable transport failure/u);
  expect(await executePageSupportComparisonFill({ ...fixture, config: fixture.config })).toMatchObject({ attempts: 0, terminal_failures: 1 });
  expect(predecessorBytes(fixture)).toEqual(retained); expect(fixture.bodies).toHaveLength(1);
  expect(existsSync(continuationChildClaimPath(fixture.cacheRoot, fixture.authority.attempt_lineage_digest))).toBe(false);
});

it("reads receipt-bound historical child results after executable revision changes while refusing all execution", async () => {
  const fixture = await failedFixture();
  const authority = pin(prepare(fixture));
  await execute(fixture, authority);
  vi.spyOn(revisionOwner, "readCurrentExtractionAuthorityRevision").mockReturnValue("different-executable-revision");
  expect(readNew(fixture, authority)[0]?.status).toBe("assessed");
  expect(readPageSupportComparisonResults(fixture.workset, fixture.cacheRoot, CAP)[0]?.status).toBe("transport_failure");
  await expect(execute(fixture, authority)).rejects.toThrow(/executable revision changed/u);
  await expect(execute(fixture, authority, "recover")).rejects.toThrow(/executable revision changed/u);
  await expect(executePageSupportComparisonFill({ ...fixture, config: fixture.config })).rejects.toThrow(/executable revision changed/u);
  expect(fixture.bodies).toHaveLength(2);
});

it("rejects changed request, root, rates, predecessor bytes, and authority identity before dispatch", async () => {
  const fixture = await failedFixture();
  const preflight = prepare(fixture);
  expect(() => preparePageSupportComparisonTransportContinuation({ ...fixture,
    predecessorAuthority: fixture.authority,
    workset: { ...fixture.workset, items: [{ ...fixture.workset.items[0]!, question: "A different original question?" }] }
  })).toThrow(/original comparison key/u);
  expect(() => preparePageSupportComparisonTransportContinuation({ ...fixture,
    predecessorAuthority: fixture.authority, cacheRoot: join(fixture.cacheRoot, "other")
  })).toThrow(/execution root differs/u);
  expect(() => quotePageSupportComparisonTransportContinuation(preflight, 0.01, 0.42)).toThrow();
  const authority = pin(preflight);
  expect(() => verifyPageSupportComparisonTransportContinuationAuthority({ ...authority, identity_digest: "0".repeat(64) })).toThrow();
  const shardPath = resultOwner.pageSupportComparisonShardPath(fixture.cacheRoot, authority.keys[0]);
  writeFileSync(shardPath, `${readFileSync(shardPath, "utf8")}\n`);
  expect(() => pin(preflight)).toThrow(/ancestry or executable changed/u);
  await expect(execute(fixture, authority)).rejects.toThrow(/predecessor evidence changed/u);
  expect(fixture.bodies).toHaveLength(1);
});

it("permits only the first authority's child claim and refuses a competing sibling", async () => {
  const fixture = await failedFixture();
  const preflight = prepare(fixture);
  const first = pin(preflight);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  const sibling = pin(preflight);
  vi.useRealTimers();
  expect(sibling.identity_digest).not.toBe(first.identity_digest);
  await execute(fixture, first);
  await expect(execute(fixture, sibling)).rejects.toThrow(/claimed by a sibling child/u);
  expect(fixture.bodies).toHaveLength(2);
});

it("serializes concurrent same-child execution through the existing physical-root writer lease", async () => {
  const fixture = await failedFixture();
  const authority = pin(prepare(fixture));
  const results = await Promise.allSettled([execute(fixture, authority), execute(fixture, authority)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(readNew(fixture, authority)[0]?.status).toBe("assessed");
  expect(fixture.bodies).toHaveLength(2);
});

it.each(["ledger", "raw", "result", "all"] as const)(
  "preserves unclaimed %s evidence and rejects execute/recover despite receipt timestamp or executable revision changes", async artifact => {
    const fixture = await failedFixture();
    const predecessor = predecessorBytes(fixture);
    const preflight = prepare(fixture);
    const authority = pin(preflight);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const sibling = pin(preflight);
    vi.useRealTimers();
    const revision = vi.spyOn(revisionOwner, "readCurrentExtractionAuthorityRevision").mockReturnValue("prospective-executable-revision");
    const successor = pin(prepare(fixture));
    revision.mockRestore();
    expect(successor.attempt_lineage_digest).not.toBe(authority.attempt_lineage_digest);
    await execute(fixture, authority);
    const key = authority.keys[0];
    const files = {
      ledger: join(fixture.cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`),
      raw: rawOwner.providerRawAttemptPath(fixture.cacheRoot, key, 2, authority.attempt_lineage_digest),
      result: resultOwner.pageSupportComparisonContinuationResultPath(fixture.cacheRoot, key, authority.attempt_lineage_digest)
    };
    const retained = Object.entries(files).filter(([kind]) => artifact === "all" || kind === artifact)
      .map(([, path]) => ({ path, bytes: readFileSync(path, "utf8") }));
    for (const [kind, path] of Object.entries(files)) if (artifact !== "all" && kind !== artifact) unlinkSync(path);
    const claimPath = continuationChildClaimPath(fixture.cacheRoot, fixture.authority.attempt_lineage_digest);
    unlinkSync(claimPath);
    const lease = acquireExtractionCacheWriteLease(fixture.cacheRoot);
    try {
      expect(() => readPageSupportComparisonTransportContinuationResults({ ...fixture, authority,
        cacheRoot: lease.stableRootPath, writeLease: lease })).toThrow(/evidence exists without its child claim/u);
    } finally { lease.release(); }
    for (const receipt of [authority, sibling]) {
      expect(() => readNew(fixture, receipt)).toThrow(/evidence exists without its child claim/u);
      for (const mode of ["execute", "recover"] as const) {
        await expect(execute(fixture, receipt, mode)).rejects.toThrow(/evidence exists without its child claim/u);
      }
    }
    expect(() => prepare(fixture)).toThrow(/evidence exists without its child claim/u);
    vi.spyOn(revisionOwner, "readCurrentExtractionAuthorityRevision").mockReturnValue("prospective-executable-revision");
    for (const mode of ["execute", "recover"] as const) {
      await expect(execute(fixture, successor, mode)).rejects.toThrow(/evidence exists without its child claim/u);
    }
    expect(() => prepare(fixture)).toThrow(/evidence exists without its child claim/u);
    expect(existsSync(claimPath)).toBe(false);
    for (const file of retained) expect(readFileSync(file.path, "utf8")).toBe(file.bytes);
    expect(predecessorBytes(fixture)).toEqual(predecessor);
    expect(fixture.bodies).toHaveLength(2);
  }
);

it("reopens a claimed child interrupted before fork publication without losing its single opportunity", async () => {
  const fixture = await failedFixture();
  const authority = pin(prepare(fixture));
  const fork = vi.spyOn(ledgerOwner, "ensureForkedExtractionAttemptLedger").mockImplementationOnce(() => { throw diskFailure(); });
  await expect(execute(fixture, authority)).rejects.toThrow(/fixture disk interruption/u);
  expect(readNew(fixture, authority)[0]?.status).toBe("pending");
  expect(fixture.bodies).toHaveLength(1);
  fork.mockRestore();
  expect(await execute(fixture, authority)).toMatchObject({ attempts: 1, cumulative_attempts: 2, status: "assessed" });
  expect(fixture.bodies).toHaveLength(2);
});

it.each(["before", "after"] as const)("counts a new durable admission when recovering interruption %s result publication without a third HTTP request", async phase => {
  const fixture = await failedFixture();
  const retained = predecessorBytes(fixture);
  const authority = pin(prepare(fixture));
  const publish = resultOwner.writePageSupportComparisonContinuationShard;
  const interrupted = vi.spyOn(resultOwner, "writePageSupportComparisonContinuationShard").mockImplementationOnce((root, shard) => {
    if (phase === "after") publish(root, shard);
    throw diskFailure();
  });
  await expect(execute(fixture, authority)).rejects.toThrow(/fixture disk interruption/u);
  expect(readNew(fixture, authority)[0]?.status).toBe("pending");
  interrupted.mockRestore();
  expect(await execute(fixture, authority, "recover")).toMatchObject({ attempts: 0, cumulative_attempts: 2, newly_admitted: 1, status: "assessed" });
  expect(await execute(fixture, authority, "recover")).toMatchObject({ attempts: 0, cumulative_attempts: 2, newly_admitted: 0, status: "assessed" });
  expect(predecessorBytes(fixture)).toEqual(retained);
  expect(fixture.bodies).toHaveLength(2);
});

it("retains a dispatched reservation with missing raw as unknown and never redispatches it", async () => {
  const fixture = await failedFixture();
  const retained = predecessorBytes(fixture);
  const authority = pin(prepare(fixture));
  const writeRaw = vi.spyOn(rawOwner, "writeProviderRawAttempt").mockImplementationOnce(() => { throw diskFailure(); });
  await expect(execute(fixture, authority)).rejects.toThrow(/fixture disk interruption/u);
  expect(readNew(fixture, authority)[0]?.status).toBe("unknown");
  writeRaw.mockRestore();
  expect(await execute(fixture, authority, "recover")).toMatchObject({ attempts: 0, cumulative_attempts: 2, status: "unknown" });
  expect(await execute(fixture, authority)).toMatchObject({ attempts: 0, cumulative_attempts: 2, status: "unknown" });
  expect(predecessorBytes(fixture)).toEqual(retained);
  expect(fixture.bodies).toHaveLength(2);
});

async function failedFixture(responses: Response[] = ["failure", "assessed"]) {
  const bodies: string[] = [];
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    paths.push(request.url ?? "");
    respond(response, responses[bodies.length - 1] ?? "failure");
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const selected = new URL(input instanceof Request ? input.url : String(input));
    if (selected.origin !== "https://api.stepfun.com") throw new Error("fixture refused a foreign provider route");
    return fetchLoopbackProvider(fetch, new URL(selected.pathname, origin), init);
  });
  const root = mkdtempSync(join(tmpdir(), "comparison-transport-continuation-"));
  roots.push(root);
  const cacheRoot = join(root, "cache");
  const workset = makeWorkset();
  const config: CompileSeedExtractionConfig = { providerUrl: STEP_OPENAPI_QUOTE_BASIS.selected_provider_url,
    model: MODEL, requestProfile: PROFILE, apiKey: "loopback-only" };
  const preflight = preparePageSupportComparison(workset, cacheRoot, CAP);
  const authority = pinPageSupportComparisonAuthority({ preflight, inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.42 });
  await executePageSupportComparisonFill({ workset, cacheRoot, authority, config });
  return { workset, cacheRoot, authority, config, bodies, paths };
}

function makeWorkset() {
  const original = { text: TEXT, preview_sha256: createHash("sha256").update(TEXT).digest("hex"),
    span: { content_start: 0, content_end: Buffer.byteLength(TEXT), retained_extent: "body",
      content_complete: true, original_complete: false },
    source_disclosure: [1, "original_body", "checked_record", null, "2024-06-01T00:00:00.000Z",
      { kind: "known", at: "2024-05-01T12:00:00.000Z" }, { kind: "unknown", reason: "not_recorded" }, "unknown",
      { kind: "source_only", qualification: "not_current_proof" }] };
  return parsePageSupportComparisonWorkset({ contract: PAGE_SUPPORT_COMPARISON_WORKSET_CONTRACT,
    model: MODEL, provider_url: STEP_OPENAPI_QUOTE_BASIS.selected_provider_url, request_profile: PROFILE,
    items: [{ question: "Who left the lab and when?", query_as_of: { status: "unknown" }, arm_a: [original], arm_b: [original] }] });
}

function respond(response: ServerResponse, kind: Response) {
  if (kind === "failure" || kind === "authentication") {
    response.writeHead(kind === "authentication" ? 401 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "fixture temporary unavailable" } }));
    return;
  }
  const quote = kind === "invalid" ? "A quote absent from the captured source" : "Lee left the lab on Tuesday";
  const body = kind === "abstained" ? { status: "cannot_assess", claims: [], answer_a: "none", answer_b: "none", unresolved: ["Insufficient evidence."] }
    : { status: "assessed", claims: [{ claim: "Lee left the lab on Tuesday.", support: "both",
      qualifications: ["Departure is reported by the source."], a_quotes: [{ source_index: 0, quote }],
      b_quotes: [{ source_index: 0, quote }], uncertainty: "Speaker identity is unknown." }],
      answer_a: "partial", answer_b: "partial", unresolved: ["Person identity is unknown."] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(body) },
    finish_reason: kind === "incomplete" ? "length" : "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`);
}

type Fixture = Awaited<ReturnType<typeof failedFixture>>;
type ContinuationAuthority = ReturnType<typeof pinPageSupportComparisonTransportContinuationAuthority>;
function prepare(fixture: Fixture) {
  return preparePageSupportComparisonTransportContinuation({ ...fixture, predecessorAuthority: fixture.authority });
}
function pin(preflight: ReturnType<typeof prepare>) {
  return pinPageSupportComparisonTransportContinuationAuthority({ preflight, inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.42 });
}
function execute(fixture: Fixture, authority: ContinuationAuthority, mode: "execute" | "recover" = "execute") {
  return executePageSupportComparisonTransportContinuationFill({ ...fixture, authority, mode });
}
function readNew(fixture: Fixture, authority: ContinuationAuthority) {
  return readPageSupportComparisonTransportContinuationResults({ ...fixture, authority });
}
function predecessorBytes(fixture: Fixture) {
  const key = fixture.authority.keys[0]!;
  return [resultOwner.pageSupportComparisonShardPath(fixture.cacheRoot, key),
    rawOwner.providerRawAttemptPath(fixture.cacheRoot, key, 1),
    join(fixture.cacheRoot, `extraction-attempt-ledger.${fixture.authority.attempt_lineage_digest}.json`)]
    .map(path => readFileSync(path, "utf8"));
}
function diskFailure() { return Object.assign(new Error("fixture disk interruption"), { code: "ENOSPC" }); }
