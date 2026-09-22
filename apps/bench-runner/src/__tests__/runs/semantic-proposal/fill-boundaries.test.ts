import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  pinSemanticProposalAuthority, readSemanticProposalAuthority
} from "../../../runs/semantic-proposal/authority.js";
import {
  inspectSemanticProposalShard, SemanticProposalIdentityError, SEMANTIC_PROPOSAL_CACHE_CONTRACT,
  writeSemanticProposalShard, isExecutableProposalShard
} from "../../../runs/semantic-proposal/artifact.js";
import {
  executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults
} from "../../../runs/semantic-proposal/fill.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import {
  ProviderRawAttemptIdentityError, readProviderRawAttempt, requestEnvelopeDigest,
  writeProviderRawAttempt
} from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { openSemanticProposalAttemptLedger } from "../../../runs/semantic-proposal/attempt.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";

const MODEL = "gemini-3.1-flash-lite";
const PROFILE = "gemini-3.1-minimal-v1" as const;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "proposal-process-fixture.mjs");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const roots: string[] = [];

it("keeps admitted legacy shards without completion witnesses non-executable", () => {
  const shard = {
    attempt_lineage_digest: "b".repeat(64), request_digest: "c".repeat(64),
    transport_provenance: { model: MODEL, provider_url_sha256: `sha256:${"d".repeat(64)}` },
    contract: SEMANTIC_PROPOSAL_CACHE_CONTRACT, kind: "query" as const, cache_key: "a".repeat(64),
    model: MODEL, request_profile: PROFILE, original_query: "Who?", system_prompt: "system", user_prompt: "user",
    raw_json: "{}", outcome: { status: "interpreted" }, admitted: true, attempt_ordinal: 1, extracted_at: "now"
  };
  expect(isExecutableProposalShard(shard)).toBe(false);
  expect(isExecutableProposalShard({ ...shard, finish_reason: "STOP" })).toBe(false);
  expect(isExecutableProposalShard({ ...shard, finish_reason: "STOP", completion_witness: "finish_reason" })).toBe(true);
});

it.each([JSON.stringify({ contract: "source-semantic-query-response-v5", outcome: { status: "abstained" } }), "{}"])(
  "recovers a published terminal shard before ledger settlement without credentials: %s", async (rawJson) => {
    const cacheRoot = tempRoot();
    const prepared = workset();
    const authority = pinSemanticProposalAuthority({
      preflight: prepareSemanticProposal(prepared, cacheRoot, 128), inputUsdPerMillion: 1, outputUsdPerMillion: 2
    });
    const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
    let reserved = "";
    await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: config(), extractor: {
      extract: async () => {
        reserved = readFileSync(ledgerPath, "utf8");
        return { rawJson, responseMetadata: { finishReason: "STOP" }, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
      }
    } });
    expect(readSemanticProposalResults(prepared, cacheRoot, 128)[0]?.status)
      .toBe(rawJson === "{}" ? "invalid" : "abstained");
    writeFileSync(ledgerPath, reserved);
    for (let replay = 0; replay < 2; replay++) {
      await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: { ...config(), apiKey: null } });
      const settled = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot();
      expect(settled.unresolvedAttempts).toEqual([]);
      expect(settled.pendingKeys).toEqual([]);
      expect(settled.telemetry.totalTokens).toBe(5);
    }
  }
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "proposal-fill-"));
  roots.push(root);
  return root;
}

function workset(context = true, queries: readonly string[] = ["Who chairs SHADOW?"]) {
  return parseSemanticProposalWorkset({
    contract: "source-semantic-proposal-workset-v3", provider_url: "http://127.0.0.1:9",
    kind: "query", model: MODEL, request_profile: PROFILE,
    items: queries.map((original_query) => ({
      original_query,
      ...(context ? { approved_fixed_context: { context_id: "fixed-ctx", notes: "keep" } } : {})
    }))
  });
}

function settledUsage() {
  return {
    retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1,
    usageRequestCount: 1, unknownRequestCount: 0,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  };
}

function settledNetworkError() {
  return {
    retryCount: 0,
    rateLimitRetries: 0,
    successfulRequestCount: 0,
    terminalRetryClassification: "failure_non_retryable_response" as const,
    transportFailures: [{
      attempt: 1,
      kind: "network_error" as const,
      phase: "request" as const,
      httpStatus: null,
      fingerprint: "a".repeat(64)
    }]
  };
}

function config(): CompileSeedExtractionConfig {
  return { providerUrl: "http://127.0.0.1:9", model: MODEL, requestProfile: PROFILE, apiKey: "synthetic-fixture-key" };
}

function extractor(raws: string[], finish: string | null = "STOP") {
  const queue = [...raws];
  const calls: string[] = [];
  return {
    calls,
    extract: async (input: { readonly userPrompt: string }) => {
      calls.push(input.userPrompt);
      const rawJson = queue.shift() ?? "{";
      return {
        rawJson,
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        responseMetadata: finish === null
          ? { finishReason: null as string | null }
          : { finishReason: finish, completionWitness: "finish_reason" as const, completionContractVersion: 1 as const }
      };
    }
  };
}

it("rejects an altered authority digest and a zero attempt cap before any extractor call", async () => {
  const root = tempRoot();
  const prepared = workset();
  const preflight = prepareSemanticProposal(prepared, root, 128);
  const authority = pinSemanticProposalAuthority({
    preflight, inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const path = join(root, "authority.json");
  writeFileSync(path, `${JSON.stringify({
    ...authority, limits: { ...authority.limits, maximum_attempts: 0 }
  }, null, 2)}\n`);
  expect(() => readSemanticProposalAuthority(path)).toThrow(/identity digest is invalid/u);
  const spy = extractor(["{}"]);
  await expect(executeSemanticProposalFill({
    workset: prepared, cacheRoot: join(root, "cache"), authority: {
      ...authority, limits: { ...authority.limits, maximum_attempts: 0 },
      identity_digest: authority.identity_digest
    }, config: config(), extractor: spy
  })).rejects.toThrow(/identity digest is invalid|maximum_attempts does not bind/u);
  expect(spy.calls).toHaveLength(0);
});

it("rejects a foreign-kind shard at the lookup path instead of treating it as a miss", () => {
  const root = tempRoot();
  const prepared = workset();
  const lines = prepareSemanticProposal(prepared, root, 128);
  const key = lines.keys[0]!;
  writeSemanticProposalShard(root, {
    attempt_lineage_digest: "b".repeat(64), request_digest: "c".repeat(64),
    transport_provenance: { model: MODEL, provider_url_sha256: `sha256:${"d".repeat(64)}` },
    contract: SEMANTIC_PROPOSAL_CACHE_CONTRACT, kind: "semantic_correspondence", cache_key: key,
    model: MODEL, request_profile: PROFILE, original_query: "who?",
    system_prompt: "sys", user_prompt: "user", raw_json: "{}",
    outcome: { status: "abstained" }, admitted: true, attempt_ordinal: 1,
    extracted_at: new Date().toISOString()
  });
  expect(() => inspectSemanticProposalShard(root, key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  })).toThrow(SemanticProposalIdentityError);
  expect(() => prepareSemanticProposal(prepared, root, 128)).toThrow(SemanticProposalIdentityError);
});

it("keeps both raw attempts after invalid JSON then a later response and binds approved context", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const spy = extractor(["not-json", "{\"outcome\":{\"status\":\"abstained\"}}"]);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: spy
  });
  expect(spy.calls).toHaveLength(2);
  expect(spy.calls[0]).toContain("fixed-ctx");
  const key = authority.keys[0]!;
  expect(readProviderRawAttempt(cacheRoot, key, 1)?.decoded_text).toBe("not-json");
  expect(readProviderRawAttempt(cacheRoot, key, 2)?.decoded_text).toContain("abstained");
  expect(result.attempts).toBe(2);
  const shard = inspectSemanticProposalShard(cacheRoot, key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  });
  expect(shard?.user_prompt).toContain("fixed-ctx");
  expect(shard?.admitted).toBe(false);
});

it("treats a disk failure after model output as local persistence failure without retry", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  mkdirSync(join(cacheRoot, "provider-raw"), { recursive: true });
  chmodSync(join(cacheRoot, "provider-raw"), 0o500);
  const spy = extractor(["{\"outcome\":{\"status\":\"abstained\"}}"]);
  await expect(executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: spy
  })).rejects.toMatchObject({ code: "EACCES" });
  expect(spy.calls).toHaveLength(1);
  chmodSync(join(cacheRoot, "provider-raw"), 0o700);
});

it("replays persisted raw without a second provider call after a reserved unresolved restart", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const key = authority.keys[0]!;
  mkdirSync(cacheRoot, { recursive: true });
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  const ordinal = ledger.reserveAttemptOrdinal(key);
  const { writeProviderRawAttempt, requestEnvelopeDigest } = await import(
    "../../../runs/extraction/fill/provider-raw-attempt.js"
  );
  const { materializeSemanticProposalLines } = await import("../../../runs/semantic-proposal/workset.js");
  const line = materializeSemanticProposalLines(prepared, 128)[0]!;
  writeProviderRawAttempt({
    root: cacheRoot, cacheKey: key, attemptOrdinal: ordinal, kind: "query",
    model: MODEL, requestProfile: PROFILE, requestDigest: line.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest,
    decodedText: "not-json", finishReason: "STOP",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  });
  const spy = extractor(["should-not-run"]);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: spy
  });
  expect(spy.calls).toHaveLength(1);
  expect(result.attempts).toBe(2);
  expect(readProviderRawAttempt(cacheRoot, key, ordinal)?.decoded_text).toBe("not-json");
});

it("gives one process the writer lease and rejects a second real process", async () => {
  const cacheRoot = tempRoot();
  mkdirSync(cacheRoot, { recursive: true });
  const holder = spawn(process.execPath, [FIXTURE], {
    cwd: REPO_ROOT,
    env: { ...process.env, PROPOSAL_CACHE_ROOT: cacheRoot, PROPOSAL_PROCESS_MODE: "hold", PROPOSAL_HOLD_MS: "4000" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const held = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("holder did not acquire")), 20_000);
    holder.stdout.setEncoding("utf8");
    holder.stdout.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.includes("HELD")) {
        clearTimeout(timer);
        resolve(buf);
      }
    });
    holder.on("exit", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`holder exited ${code}`));
    });
  });
  expect(held).toContain("HELD");
  const contender = spawn(process.execPath, [FIXTURE], {
    cwd: REPO_ROOT,
    env: { ...process.env, PROPOSAL_CACHE_ROOT: cacheRoot, PROPOSAL_PROCESS_MODE: "contend" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const contended = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    contender.stderr.setEncoding("utf8");
    contender.stderr.on("data", (chunk: string) => { stderr += chunk; });
    contender.on("exit", (code) => resolve({ code, stderr }));
  });
  holder.kill("SIGTERM");
  await new Promise((resolve) => holder.on("exit", resolve));
  expect(contended.code).toBe(2);
  expect(contended.stderr).toMatch(/already has an active writer lock/u);
}, 30_000);

it.each([
  { label: "HTTP 500", status: 500, attempts: 2, body: '{"error":{"code":500,"message":"fixture failed"}}',
    kind: "http_error", phase: "response_status", finish: null, known: false },
  { label: "thought-only STOP", body: JSON.stringify({ candidates: [{ finishReason: "STOP", content: {
    parts: [{ thought: true, text: "private synthetic thought" }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, thoughtsTokenCount: 3, totalTokenCount: 13 } }),
    kind: "response_schema_error", phase: "response_schema", finish: "STOP", known: true },
  { label: "provider rejection", body: JSON.stringify({ error: { code: 429, message: "fixture rejected" },
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, thoughtsTokenCount: 3, totalTokenCount: 13 } }),
    kind: "provider_error", phase: "response_parse", finish: null, known: true },
  { label: "malformed body", body: "{", kind: "response_parse_error", phase: "response_parse", finish: null, known: false },
  { label: "malformed envelope", body: "{}", kind: "response_schema_error", phase: "response_schema", finish: null, known: false }
]) ("retains classified $label evidence within its exact attempt ceiling", async (response) => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  let hits = 0;
  const wires: { url: string | undefined; body: unknown }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => {
      hits += 1;
      wires.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.statusCode = response.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(response.body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const prepared = { ...workset(), provider_url: origin };
    const authority = pinSemanticProposalAuthority({
      preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
      inputUsdPerMillion: 1, outputUsdPerMillion: 2
    });
    const result = await executeSemanticProposalFill({
      workset: prepared, cacheRoot, authority, config: { ...config(), providerUrl: origin }
    });
    expect(hits).toBe("attempts" in response ? response.attempts : 1);
    expect(result.attempts).toBe("attempts" in response ? response.attempts : 1);
    expect(result.newly_admitted).toBe(0);
    expect(result.terminal_failures).toBe(1);
    for (const wire of wires) {
      expect(wire.url).toBe("/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse");
      expect(wire.body).not.toHaveProperty("generationConfig.responseJsonSchema");
      expect(wire.body).toMatchObject({ generationConfig: { responseMimeType: "application/json" },
        systemInstruction: { parts: [expect.anything(), { text: expect.stringContaining("source-semantic-query-meaning-v3") }] } });
    }
    expect(readSemanticProposalResults(prepared, cacheRoot, 128)).toMatchObject([
      { status: "transport_failure", shard: { outcome: { status: "transport_failure" } } }
    ]);
    const key = authority.keys[0]!;
    expect(readProviderRawAttempt(cacheRoot, key, 1)).toMatchObject({
      decoded_text: "",
      finish_reason: response.finish, completion_witness: response.finish === null ? null : "finish_reason",
      transport_failure: { kind: response.kind, phase: response.phase, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      response_body: { text: response.body, truncated: false }, usage_known: response.known,
      usage: response.known ? { inputTokens: 10, outputTokens: 3, totalTokens: 13 } : null
    });
    expect(inspectSemanticProposalShard(cacheRoot, key, {
      kind: "query", model: MODEL, request_profile: PROFILE
    })?.admitted).toBe(false);
    const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
    expect(ledger.snapshot().unresolvedAttempts).toEqual([]);
    expect(ledger.snapshot().transportFailures.every((failure) => failure.kind === response.kind && failure.phase === response.phase)).toBe(true);
    if ("attempts" in response) expect(readProviderRawAttempt(cacheRoot, key, 2)).toMatchObject({
      failure_retryable: true, response_body: { text: response.body }, transport_failure: { kind: "http_error", httpStatus: 500 }
    });
    expect(ledger.snapshot().successfulShards).toBe(0);
    await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: { ...config(), providerUrl: origin, apiKey: null } });
    expect(hits).toBe("attempts" in response ? response.attempts : 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}, 20_000);

it("settles a local connection refusal as classified transport", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config()
  });
  expect(result.newly_admitted).toBe(0);
  expect(result.attempts).toBe(2);
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  expect(ledger.snapshot().unresolvedAttempts).toEqual([]);
  expect(ledger.snapshot().transportFailures.length).toBeGreaterThan(0);
  expect(ledger.snapshot().transportFailures.every((item) => item.kind === "network_error")).toBe(true);
}, 20_000);

it("does not classify a programmer extract error as transport failure", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  await expect(executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(),
    extractor: {
      extract: async () => {
        throw new TypeError("extractor contract broken");
      }
    } as never
  })).rejects.toThrow(/extractor contract broken/u);
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  expect(ledger.snapshot().attempts).toBe(1);
  expect(ledger.snapshot().unresolvedAttempts.map((item) => item.attemptOrdinal)).toEqual([1]);
  expect(ledger.snapshot().transportFailures).toEqual([]);
});

it("does not dispatch another provider attempt when an unresolved reservation has no raw", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const key = authority.keys[0]!;
  mkdirSync(cacheRoot, { recursive: true });
  const reserved = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  reserved.reserveAttemptOrdinal(key);
  const spy = extractor(['{"outcome":{"status":"abstained"}}']);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: spy
  });
  expect(spy.calls).toHaveLength(0);
  expect(result.attempts).toBe(1);
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  expect(ledger.snapshot().attempts).toBe(1);
  expect(ledger.snapshot().unresolvedAttempts.map((item) => item.attemptOrdinal)).toEqual([1]);
});

it("rejects a same-kind shard whose request body does not match the workset", async () => {
  const planted = tempRoot();
  const prepared = workset();
  const line = materializeSemanticProposalLines(prepared, 128)[0]!;
  writeSemanticProposalShard(planted, {
    attempt_lineage_digest: "b".repeat(64), request_digest: "c".repeat(64),
    transport_provenance: { model: MODEL, provider_url_sha256: `sha256:${"d".repeat(64)}` },
    contract: SEMANTIC_PROPOSAL_CACHE_CONTRACT, kind: "query", cache_key: line.key,
    model: MODEL, request_profile: PROFILE, original_query: "Who chairs SHADOW?",
    system_prompt: line.systemPrompt, user_prompt: "{\"foreign\":true}", raw_json: "{}",
    outcome: { status: "interpreted" }, admitted: true, attempt_ordinal: 1,
    extracted_at: new Date().toISOString(), finish_reason: "STOP",
    raw_digest: createHash("sha256").update("{}", "utf8").digest("hex"), max_output_tokens: 128
  });
  expect(() => prepareSemanticProposal(prepared, planted, 128)).toThrow(SemanticProposalIdentityError);
  const spy = extractor(["should-not-run"]);
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, tempRoot(), 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  await expect(executeSemanticProposalFill({
    workset: prepared, cacheRoot: planted, authority, config: config(), extractor: spy
  })).rejects.toThrow(SemanticProposalIdentityError);
  expect(spy.calls).toHaveLength(0);
});

it("binds output cap into the proposal cache key", () => {
  const root = tempRoot();
  const prepared = workset();
  const low = prepareSemanticProposal(prepared, root, 128);
  const high = prepareSemanticProposal(prepared, root, 4096);
  expect(low.keys[0]).not.toBe(high.keys[0]);
});

it("replays an exact request cache hit without a second provider call", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const first = extractor(['{"outcome":{"status":"abstained"}}']);
  await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: first
  });
  expect(first.calls).toHaveLength(1);
  const second = extractor(["should-not-run"]);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: second
  });
  expect(second.calls).toHaveLength(0);
  expect(result.cache_hits).toBe(1);
  expect(result.newly_admitted).toBe(0);
});

it("rejects a forged interpreted cache shard after re-admission", () => {
  const root = tempRoot();
  const prepared = workset();
  const line = materializeSemanticProposalLines(prepared, 128)[0]!;
  writeSemanticProposalShard(root, {
    attempt_lineage_digest: "b".repeat(64), request_digest: "c".repeat(64),
    transport_provenance: { model: MODEL, provider_url_sha256: `sha256:${"d".repeat(64)}` },
    contract: SEMANTIC_PROPOSAL_CACHE_CONTRACT, kind: "query", cache_key: line.key,
    model: MODEL, request_profile: PROFILE, original_query: "Who chairs SHADOW?",
    system_prompt: line.systemPrompt, user_prompt: line.userPrompt, raw_json: "not-json",
    outcome: { status: "interpreted" }, admitted: true, attempt_ordinal: 1,
    extracted_at: new Date().toISOString(), finish_reason: "STOP",
    raw_digest: createHash("sha256").update("not-json", "utf8").digest("hex"), max_output_tokens: 128
  });
  expect(() => prepareSemanticProposal(prepared, root, 128)).toThrow(SemanticProposalIdentityError);
});

it("replays a missing-finish shard as a cache hit instead of an identity error", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const first = extractor(['{"outcome":{"status":"abstained"}}'], null);
  await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: first
  });
  expect(first.calls).toHaveLength(1);
  expect(() => prepareSemanticProposal(prepared, cacheRoot, 128)).not.toThrow();
  const second = extractor(["should-not-run"]);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: second
  });
  expect(second.calls).toHaveLength(0);
  expect(result.cache_hits).toBe(1);
  expect(result.newly_admitted).toBe(0);
  expect(result.cached_invalid).toBe(1);
});

it("publishes a non-executable shard after the last malformed JSON attempt", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const first = extractor(["not-json", "also-not-json"]);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: first
  });
  expect(first.calls).toHaveLength(2);
  expect(result.attempts).toBe(2);
  const key = authority.keys[0]!;
  const shard = inspectSemanticProposalShard(cacheRoot, key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  });
  expect(shard?.admitted).toBe(false);
  expect(shard?.outcome).toMatchObject({ status: "invalid", reason: "malformed_json" });
  expect(() => prepareSemanticProposal(prepared, cacheRoot, 128)).not.toThrow();
  const second = extractor(["should-not-run"]);
  const replayed = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: second
  });
  expect(second.calls).toHaveLength(0);
  expect(replayed.cache_hits).toBe(1);
  expect(replayed.cached_invalid).toBe(1);
  expect(replayed.newly_admitted).toBe(0);
});

it("replays persisted raw without a second provider call after a shard write failure", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const key = authority.keys[0]!;
  mkdirSync(cacheRoot, { recursive: true });
  const bucket = join(cacheRoot, key.slice(0, 2));
  writeFileSync(bucket, "not-a-directory");
  const first = extractor(['{"outcome":{"status":"abstained"}}']);
  await expect(executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: first
  })).rejects.toSatisfy((cause: NodeJS.ErrnoException) =>
    cause.code === "EEXIST" || cause.code === "ENOTDIR");
  expect(first.calls).toHaveLength(1);
  expect(readProviderRawAttempt(cacheRoot, key, 1)?.decoded_text).toContain("abstained");
  unlinkSync(bucket);
  const second = extractor(["should-not-run"]);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: second
  });
  expect(second.calls).toHaveLength(0);
  expect(result.newly_admitted).toBe(0);
  expect(inspectSemanticProposalShard(cacheRoot, key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  })?.admitted).toBe(false);
});

it("replays a settled raw without a shard instead of treating the key as missing work", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const key = authority.keys[0]!;
  mkdirSync(cacheRoot, { recursive: true });
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  const ordinal = ledger.reserveAttemptOrdinal(key);
  const line = materializeSemanticProposalLines(prepared, 128)[0]!;
  writeProviderRawAttempt({
    root: cacheRoot, cacheKey: key, attemptOrdinal: ordinal, kind: "query",
    model: MODEL, requestProfile: PROFILE, requestDigest: line.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest,
    decodedText: '{"outcome":{"status":"abstained"}}', finishReason: "STOP",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  });
  ledger.recordTransportOutcome(key, {
    retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1,
    usageRequestCount: 1, unknownRequestCount: 0,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  }, ordinal);
  const spy = extractor(["should-not-run"]);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: spy
  });
  expect(spy.calls).toHaveLength(0);
  expect(result.attempts).toBe(1);
  expect(inspectSemanticProposalShard(cacheRoot, key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  })?.admitted).toBe(false);
});

it("does not admit parseable JSON with a missing finish as a complete extraction", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const spy = extractor(['{"outcome":{"status":"abstained"}}'], null);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: spy
  });
  const key = authority.keys[0]!;
  expect(result.newly_admitted).toBe(0);
  expect(readProviderRawAttempt(cacheRoot, key, 1)?.finish_reason).toBeNull();
  expect(inspectSemanticProposalShard(cacheRoot, key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  })?.admitted).toBe(false);
});

it("restarts a later key from its own reserved raws instead of the global attempt ordinal", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset(true, ["Who chairs SHADOW?", "Who sent the sample to Mira?"]);
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const [line1, line2] = materializeSemanticProposalLines(prepared, 128);
  if (line1 === undefined || line2 === undefined) throw new Error("expected two proposal lines");
  mkdirSync(cacheRoot, { recursive: true });
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  const first = ledger.reserveAttemptOrdinal(line1.key);
  writeProviderRawAttempt({
    root: cacheRoot, cacheKey: line1.key, attemptOrdinal: first, kind: "query",
    model: MODEL, requestProfile: PROFILE, requestDigest: line1.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest,
    decodedText: "not-json", finishReason: "STOP",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  });
  ledger.recordTransportOutcome(line1.key, settledUsage(), first);
  const second = ledger.reserveAttemptOrdinal(line1.key);
  writeProviderRawAttempt({
    root: cacheRoot, cacheKey: line1.key, attemptOrdinal: second, kind: "query",
    model: MODEL, requestProfile: PROFILE, requestDigest: line1.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest,
    decodedText: '{"outcome":{"status":"abstained"}}', finishReason: "STOP",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  });
  ledger.recordTransportOutcome(line1.key, settledUsage(), second);
  ledger.abandonPendingShard(line1.key, second);
  const third = ledger.reserveAttemptOrdinal(line2.key);
  expect(third).toBe(3);
  writeProviderRawAttempt({
    root: cacheRoot, cacheKey: line2.key, attemptOrdinal: third, kind: "query",
    model: MODEL, requestProfile: PROFILE, requestDigest: line2.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest,
    decodedText: "not-json", finishReason: "STOP",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  });
  ledger.recordTransportOutcome(line2.key, settledUsage(), third);
  const spy = extractor(['{"outcome":{"status":"abstained"}}']);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: spy
  });
  expect(spy.calls).toHaveLength(1);
  expect(spy.calls[0]).toContain("Who sent the sample to Mira?");
  expect(result.attempts).toBe(4);
  expect(readProviderRawAttempt(cacheRoot, line2.key, 3)?.decoded_text).toBe("not-json");
  expect(readProviderRawAttempt(cacheRoot, line2.key, 4)?.decoded_text).toContain("abstained");
  expect(readProviderRawAttempt(cacheRoot, line1.key, 1)?.decoded_text).toBe("not-json");
  expect(readProviderRawAttempt(cacheRoot, line1.key, 2)?.decoded_text).toContain("abstained");
});

it("restarts from a settled transport-without-raw using remaining per-key attempts", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset(true, ["Who chairs SHADOW?", "Who sent the sample to Mira?"]);
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const [line1, line2] = materializeSemanticProposalLines(prepared, 128);
  if (line1 === undefined || line2 === undefined) throw new Error("expected two proposal lines");
  mkdirSync(cacheRoot, { recursive: true });
  const planted = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  const ordinal = planted.reserveAttemptOrdinal(line1.key);
  planted.recordTransportOutcome(line1.key, settledNetworkError(), ordinal);
  expect(readProviderRawAttempt(cacheRoot, line1.key, ordinal)).toBeUndefined();
  const spy = extractor(["not-json", "not-json", "not-json"]);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: spy
  });
  expect(spy.calls).toHaveLength(3);
  expect(spy.calls.filter((prompt) => prompt.includes("Who chairs SHADOW?"))).toHaveLength(1);
  expect(spy.calls.filter((prompt) => prompt.includes("Who sent the sample to Mira?"))).toHaveLength(2);
  expect(result.attempts).toBe(4);
  expect(readProviderRawAttempt(cacheRoot, line1.key, 1)).toBeUndefined();
  expect(readProviderRawAttempt(cacheRoot, line1.key, 2)?.decoded_text).toBe("not-json");
  expect(readProviderRawAttempt(cacheRoot, line2.key, 3)?.decoded_text).toBe("not-json");
  expect(readProviderRawAttempt(cacheRoot, line2.key, 4)?.decoded_text).toBe("not-json");
  expect(inspectSemanticProposalShard(cacheRoot, line2.key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  })).toBeDefined();
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  expect(ledger.snapshot().attempts).toBe(4);
});

it("publishes a last-attempt shard when the global ceiling leaves fewer slots than remaining per-key attempts", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset(true, ["Who chairs SHADOW?", "Who sent the sample to Mira?"]);
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const [line1, line2] = materializeSemanticProposalLines(prepared, 128);
  if (line1 === undefined || line2 === undefined) throw new Error("expected two proposal lines");
  mkdirSync(cacheRoot, { recursive: true });
  const planted = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  for (let index = 0; index < 3; index += 1) {
    const ordinal = planted.reserveAttemptOrdinal(line1.key);
    planted.recordTransportOutcome(line1.key, settledNetworkError(), ordinal);
  }
  const spy = extractor(["not-json", "not-json"]);
  const result = await executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: spy
  });
  expect(spy.calls).toHaveLength(1);
  expect(spy.calls[0]).toContain("Who sent the sample to Mira?");
  expect(result.attempts).toBe(4);
  expect(inspectSemanticProposalShard(cacheRoot, line2.key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  })?.outcome).toMatchObject({ status: "invalid", reason: "malformed_json" });
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  expect(ledger.snapshot().attempts).toBe(4);
});

it("rejects a planted foreign raw at the resume path instead of treating it as this request", async () => {
  const root = tempRoot();
  const cacheRoot = join(root, "cache");
  const prepared = workset();
  const authority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const key = authority.keys[0]!;
  mkdirSync(cacheRoot, { recursive: true });
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  const ordinal = ledger.reserveAttemptOrdinal(key);
  writeProviderRawAttempt({
    root: cacheRoot, cacheKey: key, attemptOrdinal: ordinal, kind: "semantic_correspondence",
    attemptLineageDigest: authority.attempt_lineage_digest,
    model: MODEL, requestProfile: PROFILE, requestDigest: requestEnvelopeDigest("{\"foreign\":true}"),
    decodedText: '{"outcome":{"status":"abstained"}}', finishReason: "STOP",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  });
  ledger.recordTransportOutcome(key, settledUsage(), ordinal);
  const spy = extractor(["should-not-run"]);
  await expect(executeSemanticProposalFill({
    workset: prepared, cacheRoot, authority, config: config(), extractor: spy
  })).rejects.toThrow(ProviderRawAttemptIdentityError);
  expect(spy.calls).toHaveLength(0);
  expect(inspectSemanticProposalShard(cacheRoot, key, {
    kind: "query", model: MODEL, request_profile: PROFILE
  })).toBeUndefined();
});
