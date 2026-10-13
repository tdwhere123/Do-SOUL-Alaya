import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { executeSemanticChainConsumer } from "../../../runs/semantic-chain/consumer/execute.js";
import { admitConsumerPreparation, prepareSemanticChainConsumer } from "../../../runs/semantic-chain/consumer/input.js";
import { consumerResultPath, openConsumerAttemptLedger } from "../../../runs/semantic-chain/consumer/persist.js";
import { acquireExtractionCacheWriteLease } from "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { chainIdentity } from "../../../runs/semantic-chain/contract.js";
import * as extractionInspection from "../../../runs/extraction/authority/inspection.js";
import * as providerHttp from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { nativeConsumerFixture, revisedQueryConsumerFixture, consumerAuthority, CONSUMER_CONFIG, QUESTION, HIDDEN_SOURCE, HIDDEN_GOLD } from "./consumer.test-support.js";

let fixture: Awaited<ReturnType<typeof nativeConsumerFixture>>;
let revisedFixture: Awaited<ReturnType<typeof revisedQueryConsumerFixture>>;
let handler: (res: ServerResponse) => void;
let hits = 0, ledgerPath = "", reserved = "";
const bodies: unknown[] = [];
const server = createServer((req, res) => {
  // Synchronous admission checks may outlast a pooled socket's idle lifetime.
  res.setHeader("connection", "close");
  hits += 1;
  reserved = readFileSync(ledgerPath, "utf8");
  let body = "";
  req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
  req.on("end", () => { bodies.push(JSON.parse(body)); handler(res); });
});
const nativeFetch = globalThis.fetch;
const answer = { answer: "The delivered source mentions Project Aster; coverage remains partial.",
  task_completion: "partial", remaining_conditions: ["The rest of the source was not delivered."] };

beforeAll(async () => {
  fixture = await nativeConsumerFixture();
  revisedFixture = await revisedQueryConsumerFixture(fixture);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "true");
  globalThis.fetch = ((url, init) => {
    const selected = new URL(String(url));
    expect(selected.origin).toBe("https://api.stepfun.com");
    return nativeFetch(new URL(selected.pathname, origin), init);
  }) as typeof fetch;
}, 120000);

afterAll(async () => {
  globalThis.fetch = nativeFetch; vi.unstubAllEnvs();
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  if (fixture !== undefined) rmSync(fixture.root, { recursive: true, force: true });
});

function response(res: ServerResponse, content = JSON.stringify(answer), finish = "stop", usage: unknown = {
  prompt_tokens: 11, completion_tokens: 7, total_tokens: 18
}) {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }],
    ...(usage === null ? {} : { usage }) }));
}

it("passes exactly the admitted public delivery and question through native HTTP, retaining qualified answers", async () => {
  const run = consumerAuthority(fixture, "complete", ["native_delivery", "question_only"]);
  ledgerPath = run.ledgerPath; handler = res => response(res);
  const before = hits;
  const revisionReads = vi.spyOn(extractionInspection, "readCurrentExtractionAuthorityRevision");
  onTestFinished(() => revisionReads.mockRestore());
  const result = await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" });
  // Two fresh admissions, five native-input checks, and both loop and completion checks.
  expect(revisionReads).toHaveBeenCalledTimes(12);
  revisionReads.mockRestore();
  expect(hits - before).toBe(2);
  expect(result).toMatchObject({ new_attempts: 2, fidelity: "unassessed", rows: [
    { status: "complete_response", result: { outcome: { answer }, fidelity: "unassessed" } },
    { status: "complete_response" }], ledger: { attempts: 2 } });
  expect(result.ledger.successfulEntries).toHaveLength(2);
  const lines = admitConsumerPreparation(run.preparation.output_root).lines;
  const native = JSON.parse(lines[0]!.userPrompt);
  expect(native).toEqual({ original_query: QUESTION, query_as_of: "2023-09-13T00:00:00.000Z",
    evidence: fixture.admitted.replay.rows[0]!.response });
  expect(JSON.stringify(native)).toContain("Project Aster");
  expect(JSON.stringify(native)).not.toContain(HIDDEN_SOURCE);
  expect(JSON.stringify(native)).not.toContain(HIDDEN_GOLD);
  expect(native.evidence.query_semantics_status).toEqual({ status: "unavailable", reason: "absent" });
  expect(JSON.parse(lines[1]!.userPrompt)).toEqual({ original_query: QUESTION,
    query_as_of: native.query_as_of, evidence: null });
  expect(bodies.at(-2)).toMatchObject({ model: CONSUMER_CONFIG.model, max_tokens: 128,
    messages: [{ role: "system", content: lines[0]!.systemPrompt }, { role: "user", content: lines[0]!.userPrompt }] });
  const raw = readProviderRawAttempt(run.root, run.key, 1)!;
  expect(raw).toMatchObject({ kind: "task_consumer", contract: "task-consumer-raw-attempt-v1",
    full_replay_possible: true, http_response: { bodyComplete: true, bodyTruncated: false } });
  const replayRevisionReads = vi.spyOn(extractionInspection, "readCurrentExtractionAuthorityRevision");
  onTestFinished(() => replayRevisionReads.mockRestore());
  const again = await executeSemanticChainConsumer({ authority: run.authority, mode: "execute" });
  // Replay is a new admission, with its own current implementation and native snapshot checks.
  expect(replayRevisionReads).toHaveBeenCalledTimes(8);
  replayRevisionReads.mockRestore();
  expect(again.new_attempts).toBe(0); expect(hits - before).toBe(2);
});

it("recovers an already retained raw after interrupted publication without dispatch or double accounting", async () => {
  const run = consumerAuthority(fixture, "recovery"); ledgerPath = run.ledgerPath; handler = res => response(res);
  const completed = await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" });
  expect(completed.rows[0]?.status).toBe("complete_response");
  const before = hits, raw = readProviderRawAttempt(run.root, run.key, 1);
  unlinkSync(consumerResultPath(run.root, run.key)); writeFileSync(run.ledgerPath, reserved);
  const recovered = await executeSemanticChainConsumer({ authority: run.authority, mode: "recover" });
  expect(recovered).toMatchObject({ new_attempts: 0, rows: [{ status: "complete_response" }],
    ledger: { attempts: 1, telemetry: { totalTokens: 18 } } });
  expect(readProviderRawAttempt(run.root, run.key, 1)).toEqual(raw); expect(hits).toBe(before);
});

it.each([
  { name: "malformed", content: "{", finish: "stop", usage: undefined, status: "invalid", reason: "malformed_json" },
  { name: "shape", content: "{}", finish: "stop", usage: undefined, status: "invalid", reason: "answer_schema" },
  { name: "noncomplete", content: JSON.stringify(answer), finish: "length", usage: undefined, status: "incomplete", reason: "noncomplete" },
  { name: "invalid-usage", content: JSON.stringify(answer), finish: "stop", usage: { prompt_tokens: 1, completion_tokens: 200, total_tokens: 201 }, status: "invalid", reason: "invalid_usage" }
])("retains $name once and never retries it", async ({ name, content, finish, usage, status, reason }) => {
  const run = consumerAuthority(fixture, name); ledgerPath = run.ledgerPath;
  handler = res => response(res, content, finish, usage); const before = hits;
  const result = await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" });
  expect(result).toMatchObject({ new_attempts: 1, rows: [{ status, result: { complete_response: false, outcome: { reason } } }] });
  const raw = readProviderRawAttempt(run.root, run.key, 1)!;
  expect(raw.http_response?.bodyComplete).toBe(true);
  await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" });
  expect(hits - before).toBe(1); expect(readProviderRawAttempt(run.root, run.key, 1)).toEqual(raw);
});

it("keeps absent usage unknown while preserving a physically complete answer", async () => {
  const run = consumerAuthority(fixture, "usage-unknown"); ledgerPath = run.ledgerPath;
  handler = res => response(res, JSON.stringify(answer), "stop", null);
  const result = await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" });
  expect(result.rows[0]?.status).toBe("complete_response");
  expect(result.ledger.telemetry.usageUnknownAttempts).toBe(1);
  expect(readProviderRawAttempt(run.root, run.key, 1)?.usage).toBeNull();
});

it.each([401, 429, 503])("retains HTTP %s with its retry eligibility as a single unknown-cost attempt", async status => {
  const run = consumerAuthority(fixture, `http-failure-${status}`); ledgerPath = run.ledgerPath;
  handler = res => { res.statusCode = status; res.end("fixture failure"); }; const before = hits;
  const result = await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" });
  expect(result.rows[0]?.result).toMatchObject({ complete_response: false, outcome: { status: "transport_failure" } });
  expect(readProviderRawAttempt(run.root, run.key, 1)).toMatchObject({ failure_retryable: status !== 401,
    failure_classification: status === 401 ? "failure_non_retryable_4xx" : "failure_max_retries" });
  await executeSemanticChainConsumer({ authority: run.authority, mode: "recover" });
  expect(hits - before).toBe(1); expect(result.ledger.attempts).toBe(1);
});

it("retains a timed-out partial HTTP body with unknown usage and never repeats its attempt", async () => {
  const run = consumerAuthority(fixture, "partial-body-timeout"); ledgerPath = run.ledgerPath;
  const timeout = { policy: "output-token-cap-with-interactive-floor-v1", timeout_ms: 900000 };
  expect(run.preparation.request_timeout).toEqual(timeout); expect(run.authority.request_timeout).toEqual(timeout);
  const prefix = 'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n';
  let notifyReceived!: () => void, notifyDisconnected!: () => void;
  const received = new Promise<void>(resolve => { notifyReceived = resolve; });
  const disconnected = new Promise<void>(resolve => { notifyDisconnected = resolve; });
  handler = res => { res.once("close", notifyDisconnected);
    res.setHeader("content-type", "text/event-stream"); res.write(prefix); };
  const routedFetch = globalThis.fetch, before = hits;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await routedFetch(...args);
    // Observe bytes from the real socket without replacing parsing or the timeout outcome.
    return new Response(response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { controller.enqueue(chunk); notifyReceived(); }
    })), { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
  const clock = controlRequestDeadline(timeout.timeout_ms);
  try {
    let settled = false;
    const pending = executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" })
      .finally(() => { settled = true; });
    await Promise.race([received, pending.then(() => { throw new Error("consumer settled before receiving the partial body"); })]);
    expect(settled).toBe(false);
    clock.expire();
    const result = await pending; await disconnected;
    expect(result).toMatchObject({ request_timeout: timeout, new_attempts: 1,
      rows: [{ status: "transport_failure", result: { complete_response: false,
        outcome: { failure: { kind: "timeout", phase: "request", httpStatus: 200 } } } }],
      ledger: { attempts: 1, telemetry: { usageUnknownAttempts: 1, unresolvedTransportAttempts: 0,
        terminalRetryClassifications: { failure_timeout: 1 } } } });
    expect(result.ledger.unresolvedAttempts).toEqual([]);
    expect(result.ledger.successfulEntries).toEqual([]);
    const raw = readProviderRawAttempt(run.root, run.key, 1)!;
    expect(raw).toMatchObject({ usage: null, transport_failure: { kind: "timeout", httpStatus: 200 },
      http_response: { bodyComplete: false, bodyTruncated: false, bodyByteLength: Buffer.byteLength(prefix) } });
    expect(Buffer.from(raw.http_response!.bodyBase64, "base64").toString()).toBe(prefix);
    for (const mode of ["execute", "recover"] as const) {
      const replayed = await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode });
      expect(replayed).toMatchObject({ request_timeout: timeout, new_attempts: 0,
        rows: [{ status: "transport_failure" }], ledger: { attempts: 1, telemetry: { usageUnknownAttempts: 1 } } });
    }
    expect(hits - before).toBe(1); expect(readProviderRawAttempt(run.root, run.key, 1)).toEqual(raw);
  } finally { clock.restore(); globalThis.fetch = routedFetch; }
});

it("derives the deadline from the output cap and rejects resealed timeout changes before dispatch", async () => {
  const run = consumerAuthority(fixture, "timeout-binding"), before = hits;
  const large = prepareSemanticChainConsumer({ chainRoot: fixture.chainRoot, replayPath: fixture.replayPath,
    queryKey: fixture.queryKey, consumerConfig: { ...run.preparation.consumer_config, max_output_tokens: 65536 }
  }, join(fixture.root, "large-output-timeout"));
  expect(large.request_timeout).toEqual({ policy: "output-token-cap-with-interactive-floor-v1", timeout_ms: 1920000 });
  const changed = structuredClone(run.authority); changed.request_timeout.timeout_ms = 1;
  const { identity_digest: _, ...body } = changed; changed.identity_digest = chainIdentity(body);
  await expect(executeSemanticChainConsumer({ authority: changed, mode: "execute", config: CONSUMER_CONFIG }))
    .rejects.toThrow(/frozen request scope/u);
  const path = join(run.preparation.output_root, "preparation.json"), original = readFileSync(path);
  try {
    const envelope = JSON.parse(original.toString()); envelope.payload.request_timeout.timeout_ms = 1;
    envelope.identity = chainIdentity(envelope.payload); writeFileSync(path, JSON.stringify(envelope));
    await expect(executeSemanticChainConsumer({ authority: run.authority, mode: "execute", config: CONSUMER_CONFIG }))
      .rejects.toThrow(/preparation/u);
  } finally { writeFileSync(path, original); }
  expect(hits).toBe(before);
});

it("leaves a reserved attempt with no raw unknown and never dispatches a replacement", async () => {
  const run = consumerAuthority(fixture, "reserved-no-raw");
  const lines = admitConsumerPreparation(run.preparation.output_root).lines;
  openConsumerAttemptLedger(run.root, run.authority, lines).reserveAttemptOrdinal(run.key);
  const before = hits;
  for (const mode of ["recover", "execute"] as const) {
    const result = await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode });
    expect(result).toMatchObject({ new_attempts: 0, rows: [{ status: "unknown", result: null }] });
  }
  expect(hits).toBe(before);
});

it("rejects retained raw without its reservation and leaves recovery-only unattempted work untouched", async () => {
  const run = consumerAuthority(fixture, "raw-reservation"); ledgerPath = run.ledgerPath;
  const before = hits;
  const unattempted = await executeSemanticChainConsumer({ authority: run.authority, mode: "recover" });
  expect(unattempted).toMatchObject({ new_attempts: 0, rows: [{ status: "unattempted", result: null }] });
  expect(hits).toBe(before);
  handler = res => response(res);
  await executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" });
  const ledger = readFileSync(run.ledgerPath);
  unlinkSync(run.ledgerPath);
  try { await expect(executeSemanticChainConsumer({ authority: run.authority, mode: "recover" })).rejects.toThrow(); }
  finally { writeFileSync(run.ledgerPath, ledger); }
  expect(hits - before).toBe(1);
});

it("fails closed if the execution root is replaced while HTTP is in flight", async () => {
  const run = consumerAuthority(fixture, "root-race"); ledgerPath = run.ledgerPath;
  handler = res => { renameSync(run.root, `${run.root}.retired`); mkdirSync(run.root); response(res); };
  const before = hits;
  await expect(executeSemanticChainConsumer({ authority: run.authority, config: CONSUMER_CONFIG, mode: "execute" })).rejects.toThrow();
  expect(hits - before).toBe(1);
  expect(readProviderRawAttempt(run.root, run.key, 1)).toBeUndefined();
});

it("rejects changed dispatch, revision, authority, parent row and native snapshot before HTTP", async () => {
  const run = consumerAuthority(fixture, "tampering"), before = hits;
  await expect(executeSemanticChainConsumer({ authority: run.authority, mode: "execute",
    config: { ...CONSUMER_CONFIG, transportModel: "foreign-model" } })).rejects.toThrow();
  const foreign = structuredClone(run.authority);
  foreign.execution_scope.implementation_revision = `git-worktree-v1:${"0".repeat(40)}:${"0".repeat(64)}`;
  const { identity_digest: _, ...body } = foreign; foreign.identity_digest = chainIdentity(body);
  await expect(executeSemanticChainConsumer({ authority: foreign, mode: "execute", config: CONSUMER_CONFIG })).rejects.toThrow(/revision/u);
  const changed = structuredClone(run.authority); changed.keys[0] = "0".repeat(64);
  await expect(executeSemanticChainConsumer({ authority: changed, mode: "execute", config: CONSUMER_CONFIG })).rejects.toThrow(/identity/u);
  const original = readFileSync(fixture.replayPath);
  try {
    const envelope = JSON.parse(original.toString()); envelope.payload.rows[0].response.query_semantics_status.reason = "producer_failure";
    envelope.identity = chainIdentity(envelope.payload); writeFileSync(fixture.replayPath, JSON.stringify(envelope));
    await expect(executeSemanticChainConsumer({ authority: run.authority, mode: "execute", config: CONSUMER_CONFIG })).rejects.toThrow();
  } finally { writeFileSync(fixture.replayPath, original); }
  const snapshot = fixture.admitted.plan.config.snapshot_path, moved = `${snapshot}.moved`;
  renameSync(snapshot, moved);
  try { await expect(executeSemanticChainConsumer({ authority: run.authority, mode: "execute", config: CONSUMER_CONFIG })).rejects.toThrow(); }
  finally { renameSync(moved, snapshot); }
  expect(hits).toBe(before);
});

it.each(["preparation", "replay", "snapshot", "query-parent"] as const)(
  "re-admits changed %s after transport readiness before reserving an attempt", async target => {
    const selected = target === "query-parent" ? revisedFixture : fixture;
    const run = consumerAuthority(selected, `readiness-${target}`), before = hits;
    const parentLedger = target === "query-parent" ? readdirSync(revisedFixture.parentRoot)
      .find(name => name.startsWith("extraction-attempt-ledger.") && name.endsWith(".json")) : undefined;
    if (target === "query-parent") expect(parentLedger).toBeDefined();
    const path = target === "preparation" ? join(run.preparation.output_root, "preparation.json")
      : target === "replay" ? selected.replayPath
        : target === "snapshot" ? selected.admitted.plan.config.snapshot_path
          : join(revisedFixture.parentRoot, parentLedger!);
    const original = readFileSync(path), createExtractor = providerHttp.createSemanticProviderHttpExtractor;
    let changed = false;
    const factory = vi.spyOn(providerHttp, "createSemanticProviderHttpExtractor").mockImplementation((...args) => {
      const extractor = createExtractor(...args);
      return { ...extractor, assertTransportReady: async (...readyArgs) => {
        await extractor.assertTransportReady?.(...readyArgs);
        writeFileSync(path, "{}"); changed = true;
      } };
    });
    try {
      await expect(executeSemanticChainConsumer({ authority: run.authority,
        config: CONSUMER_CONFIG, mode: "execute" })).rejects.toThrow();
      expect(changed).toBe(true); expect(hits).toBe(before);
    } finally { factory.mockRestore(); writeFileSync(path, original); }
    const lines = admitConsumerPreparation(run.preparation.output_root).lines;
    expect(openConsumerAttemptLedger(run.root, run.authority, lines).snapshot().attempts).toBe(0);
  }
);

it("refuses native-output overlap, concurrent writers and replacement of the bound execution directory", async () => {
  const run = consumerAuthority(fixture, "roots"), before = hits;
  expect(() => prepareSemanticChainConsumer({ chainRoot: fixture.chainRoot, replayPath: fixture.replayPath,
    queryKey: fixture.queryKey, consumerConfig: run.preparation.consumer_config }, fixture.chainRoot)).toThrow(/separate/u);
  const lease = acquireExtractionCacheWriteLease(run.root);
  try { await expect(executeSemanticChainConsumer({ authority: run.authority, mode: "recover" })).rejects.toThrow(/lock|writer|lease/u); }
  finally { lease.release(); }
  renameSync(run.root, `${run.root}.old`); mkdirSync(run.root);
  await expect(executeSemanticChainConsumer({ authority: run.authority, mode: "execute", config: CONSUMER_CONFIG })).rejects.toThrow();
  expect(hits).toBe(before);
});

it("protects the admitted revised query's physical parent from consumer output and keeps its one attempt unchanged", () => {
  const { parentRoot, parentKey, parentHistory, admitted, chainRoot, replayPath, queryKey } = revisedFixture;
  expect(admitted.plan.queries[0]?.status).toBe("ready");
  expect(admitted.plan.config.query_workset.revision_parent_cache_root).toBe(parentRoot);
  expect(admitted.plan.config.query_cache_root).not.toBe(parentRoot);
  expect(admitted.replay.rows[0]?.status).toBe("replayed");
  const history = parentHistory(), before = hits;
  expect(history).toMatchObject({ attempts: 1, successfulKeys: [parentKey], unresolvedAttempts: [] });
  const parentBytes = () => readdirSync(parentRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const path = join(entry.parentPath, entry.name); return [path, readFileSync(path)] as const;
    });
  const bytes = parentBytes(), directoryEntries = readdirSync(parentRoot, { recursive: true });
  const input = { chainRoot, replayPath, queryKey, consumerConfig: { model: CONSUMER_CONFIG.model,
    provider_url: CONSUMER_CONFIG.providerUrl, request_profile: CONSUMER_CONFIG.requestProfile,
    max_output_tokens: 128, arms: ["native_delivery"] } };
  for (const output of [parentRoot, join(parentRoot, "consumer-output")]) {
    expect(() => prepareSemanticChainConsumer(input, output)).toThrow(/separate from native replay and producer inputs/u);
    expect(existsSync(join(output, "preparation.json"))).toBe(false);
  }
  expect(readdirSync(parentRoot, { recursive: true })).toEqual(directoryEntries);
  expect(parentBytes()).toEqual(bytes); expect(parentHistory()).toEqual(history);
  const separate = join(fixture.root, "revised-query-consumer");
  expect(prepareSemanticChainConsumer(input, separate).provider_calls).toBe(0);
  expect(admitConsumerPreparation(separate).preparation.source).toMatchObject({ query_key: queryKey });
  expect(readdirSync(separate)).toEqual(["preparation.json"]);
  expect(parentBytes()).toEqual(bytes); expect(parentHistory()).toEqual(history); expect(hits).toBe(before);
});

/** Advance only the selected request deadline; socket I/O and unrelated timers stay real. */
function controlRequestDeadline(timeoutMs: number) {
  const nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
  const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
  const schedule = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    const timer = nativeSetTimeout(callback, delay, ...args);
    if (delay === timeoutMs) pending.set(timer, () => callback(...args));
    return timer;
  });
  const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(timer => {
    if (typeof timer === "object" && timer !== null) pending.delete(timer);
    nativeClearTimeout(timer);
  });
  return {
    expire: () => {
      expect(pending.size).toBe(1);
      for (const [timer, callback] of pending) { nativeClearTimeout(timer); pending.delete(timer); callback(); }
    },
    restore: () => {
      for (const timer of pending.keys()) nativeClearTimeout(timer);
      clear.mockRestore(); schedule.mockRestore();
    }
  };
}
