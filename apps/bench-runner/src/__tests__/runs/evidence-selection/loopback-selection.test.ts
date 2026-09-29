import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { listExtractionAttemptLedgerRecords } from "../../../runs/extraction/authority/attempt-ledger.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";
import { SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME } from "../../../runs/provider-request/request-binding.js";
import { evidenceSelectionShardPath, inspectEvidenceSelectionShard } from "../../../runs/evidence-selection/artifact.js";
import { executeEvidenceSelectionFill, prepareEvidenceSelection, readEvidenceSelectionResults } from "../../../runs/evidence-selection/execute.js";
import { materializeEvidenceSelectionLines, parseEvidenceSelectionWorkset } from "../../../runs/evidence-selection/input.js";
import { openEvidenceSelectionAttemptLedger } from "../../../runs/evidence-selection/attempt.js";
import { pinEvidenceSelectionAuthority, quoteEvidenceSelection } from "../../../runs/evidence-selection/authority.js";

const MODEL = "gemini-3.1-flash-lite";
const PROFILE = "gemini-3.1-minimal-v1" as const;
const PREVIEW = "Lee left the lab on Tuesday after the sample arrived.";
const OTHER = "Advice: always label the sample before shipping.";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("selects exact quotes over loopback HTTP and replays reserved raw and settled cache without a second dispatch or bill", async () => {
  const captured: { hits: number; reservedLedger?: string; urls: string[] } = { hits: 0, urls: [] };
  const server = await listen((req, res) => {
    captured.hits += 1;
    captured.urls.push(req.url ?? "");
    captured.reservedLedger = readFileSync(ledgerPath, "utf8");
    succeed(res, proposalBody([{
      root_id: "src-alpha",
      quotes: ["Lee left the lab on Tuesday"],
      contribution: "Names the departure day."
    }]), "STOP", usage());
  });
  const origin = originOf(server);
  const cacheRoot = join(tempRoot(), "cache");
  const prepared = workset(origin);
  const preflight = prepareEvidenceSelection(prepared, cacheRoot, 128);
  expect(preflight).toMatchObject({
    contract: "source-evidence-selection-preflight-v1",
    maximum_attempts_per_key: 1,
    maximum_attempts: 1,
    missing: 1,
    provider_calls: 0
  });
  expect(preflight.keys).toHaveLength(1);
  expect(preflight.maximum_input_tokens_per_attempt).toBeGreaterThan(0);
  const estimated = quoteEvidenceSelection(preflight, 4, 18);
  expect(estimated).toBeGreaterThan(0);
  const authority = pinEvidenceSelectionAuthority({
    preflight, inputUsdPerMillion: 4, outputUsdPerMillion: 18
  });
  expect(authority.price.estimated_upper_usd).toBe(estimated);
  expect(authority.limits.max_concurrency).toBe(1);
  const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
  const config = configOf(origin);
  const first = await executeEvidenceSelectionFill({
    workset: prepared, cacheRoot, authority, config,
    extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME)
  });
  const key = authority.keys[0]!;
  const line = materializeEvidenceSelectionLines(prepared, 128)[0]!;
  const bound = readEvidenceSelectionResults(prepared, cacheRoot, 128)[0];
  expect(first).toMatchObject({ attempts: 1, newly_admitted: 1, interpreted: 1, cache_hits: 0 });
  expect(captured.hits).toBe(1);
  expect(captured.urls[0]).toBe("/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse");
  expect(bound).toMatchObject({
    status: "interpreted",
    selection: {
      selected: [{
        root_id: "src-alpha",
        quotes: ["Lee left the lab on Tuesday"],
        identity: { root_id: "src-alpha", version: "v1", digest: DIGEST_ALPHA, span: { start: 10, end: 64 } }
      }],
      unresolved: ["Speaker identity is unknown."]
    }
  });
  expect(bound && "selection" in bound && bound.selection
    ? JSON.stringify(bound.selection) : "").not.toMatch(/contribution|Names the departure/u);
  const ledger = openEvidenceSelectionAttemptLedger({ cacheRoot, authority });
  expect(ledger.snapshot().telemetry.totalTokens).toBe(18);
  expect(ledger.snapshot().successfulKeys).toEqual([key]);
  expect(inspectEvidenceSelectionShard(cacheRoot, key, {
    model: MODEL, request_profile: PROFILE
  })?.admitted).toBe(true);

  const settledReplay = await executeEvidenceSelectionFill({
    workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
  });
  expect(settledReplay).toMatchObject({ cache_hits: 1, newly_admitted: 0, interpreted: 1, attempts: 0 });
  expect(captured.hits).toBe(1);
  expect(openEvidenceSelectionAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens).toBe(18);

  unlinkSync(evidenceSelectionShardPath(cacheRoot, key));
  writeFileSync(ledgerPath, captured.reservedLedger!);
  const rawReplay = await executeEvidenceSelectionFill({
    workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
  });
  expect(rawReplay).toMatchObject({ newly_admitted: 1, interpreted: 1, attempts: 1 });
  expect(captured.hits).toBe(1);
  expect(openEvidenceSelectionAttemptLedger({ cacheRoot, authority }).snapshot().telemetry.totalTokens).toBe(18);
  expect(readEvidenceSelectionResults(prepared, cacheRoot, 128)[0]?.status).toBe("interpreted");
  expect(line.sourcesDigest).toHaveLength(64);
  server.closeAllConnections();
  await closeServer(server);
});

it.each([
  {
    label: "unknown root",
    body: proposalBody([{ root_id: "missing-root", quotes: ["Lee left"], contribution: "Not in the pool." }]),
    status: "invalid",
    reason: "unknown_root"
  },
  {
    label: "duplicate root",
    body: proposalBody([
      { root_id: "src-alpha", quotes: ["Lee left the lab"], contribution: "First." },
      { root_id: "src-alpha", quotes: ["sample arrived"], contribution: "Again." }
    ]),
    status: "invalid",
    reason: "duplicate_root"
  },
  {
    label: "quote mismatch",
    body: proposalBody([{
      root_id: "src-alpha",
      quotes: ["Lee never left the lab"],
      contribution: "Invented quote."
    }]),
    status: "invalid",
    reason: "quote_mismatch"
  }
])("rejects $label as a distinct failure without admitting empty success", async (fixture) => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, fixture.body, "STOP", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin);
    const authority = pinEvidenceSelectionAuthority({
      preflight: prepareEvidenceSelection(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    const config = configOf(origin);
    const result = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME)
    });
    expect(result).toMatchObject({ attempts: 1, newly_admitted: 0, interpreted: 0, rejected: 1 });
    expect(captured.hits).toBe(1);
    const row = readEvidenceSelectionResults(prepared, cacheRoot, 128)[0];
    expect(row).toMatchObject({ status: fixture.status, shard: { admitted: false, outcome: { reason: fixture.reason } } });
    expect(row && "selection" in row ? row.selection : undefined).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("keeps incomplete MAX_TOKENS output distinct from invalid and from abstain", async () => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, proposalBody([{
      root_id: "src-alpha",
      quotes: ["Lee left the lab on Tuesday"],
      contribution: "Truncated."
    }]), "MAX_TOKENS", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin);
    const authority = pinEvidenceSelectionAuthority({
      preflight: prepareEvidenceSelection(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    const config = configOf(origin);
    const result = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME)
    });
    expect(result).toMatchObject({ attempts: 1, newly_admitted: 0, incomplete: 1, interpreted: 0 });
    expect(captured.hits).toBe(1);
    expect(readEvidenceSelectionResults(prepared, cacheRoot, 128)[0]).toMatchObject({
      status: "incomplete",
      shard: { admitted: false, outcome: { status: "incomplete", reason: "noncomplete" }, finish_reason: "MAX_TOKENS" }
    });
    const replay = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null }
    });
    expect(replay).toMatchObject({ cache_hits: 1, attempts: 0, incomplete: 1 });
    expect(captured.hits).toBe(1);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

it("rejects mutated route before HTTP and mutated cache on read", async () => {
  const captured = { hits: 0 };
  const server = await listen((_req, res) => {
    captured.hits += 1;
    succeed(res, {
      status: "cannot_propose",
      selected: [],
      unresolved: ["The supplied previews lack the requested time scope."]
    }, "STOP", usage());
  });
  try {
    const origin = originOf(server);
    const cacheRoot = join(tempRoot(), "cache");
    const prepared = workset(origin);
    const authority = pinEvidenceSelectionAuthority({
      preflight: prepareEvidenceSelection(prepared, cacheRoot, 128),
      inputUsdPerMillion: 4, outputUsdPerMillion: 18
    });
    await expect(executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority,
      config: { ...configOf(origin), providerUrl: "http://127.0.0.1:9" }
    })).rejects.toThrow(/authorized request|model\/profile|transport/u);
    expect(captured.hits).toBe(0);
    expect(listExtractionAttemptLedgerRecords(cacheRoot)).toEqual([]);

    const config = configOf(origin);
    const result = await executeEvidenceSelectionFill({
      workset: prepared, cacheRoot, authority, config,
      extractor: createSemanticProviderHttpExtractor(config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME)
    });
    expect(result).toMatchObject({ attempts: 1, abstained: 1, newly_admitted: 0, interpreted: 0 });
    expect(captured.hits).toBe(1);
    expect(readEvidenceSelectionResults(prepared, cacheRoot, 128)[0]?.status).toBe("abstained");

    const key = authority.keys[0]!;
    const shardPath = evidenceSelectionShardPath(cacheRoot, key);
    const shard = JSON.parse(readFileSync(shardPath, "utf8")) as Record<string, unknown>;
    writeFileSync(shardPath, `${JSON.stringify({
      ...shard,
      transport_provenance: { ...(shard.transport_provenance as object), model: "gemini-2.5-flash-lite" }
    }, null, 2)}\n`);
    expect(() => readEvidenceSelectionResults(prepared, cacheRoot, 128)).toThrow(/identity mismatch/u);
    expect(prepareEvidenceSelection(workset("http://127.0.0.1:9"), join(tempRoot(), "other"), 128).keys[0])
      .not.toBe(key);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
});

const DIGEST_ALPHA = `sha256:${"a".repeat(64)}`;
const DIGEST_BETA = `sha256:${"b".repeat(64)}`;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "evidence-selection-"));
  roots.push(root);
  return root;
}

function workset(providerUrl: string) {
  return parseEvidenceSelectionWorkset({
    contract: "source-evidence-selection-workset-v1",
    model: MODEL,
    provider_url: providerUrl,
    request_profile: PROFILE,
    items: [{
      original_question: "Who left after the sample arrived?",
      metadata: null,
      sources: [
        {
          root_id: "src-alpha",
          version: "v1",
          digest: DIGEST_ALPHA,
          span: { start: 10, end: 64 },
          preview: PREVIEW,
          metadata: null
        },
        {
          root_id: "src-beta",
          version: "v1",
          digest: DIGEST_BETA,
          span: { start: 0, end: OTHER.length },
          preview: OTHER
        }
      ]
    }]
  });
}

function configOf(origin: string): CompileSeedExtractionConfig {
  return { providerUrl: origin, model: MODEL, requestProfile: PROFILE, apiKey: "loopback-only" };
}

function usage() {
  return { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
}

function proposalBody(selected: readonly { root_id: string; quotes: readonly string[]; contribution: string }[]) {
  return {
    status: "proposal" as const,
    selected,
    unresolved: ["Speaker identity is unknown."]
  };
}

function succeed(
  res: import("node:http").ServerResponse,
  body: unknown,
  finishReason: string,
  tokens: { inputTokens: number; outputTokens: number; totalTokens: number }
): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(body) }] } }],
    usageMetadata: {
      promptTokenCount: tokens.inputTokens,
      candidatesTokenCount: tokens.outputTokens,
      totalTokenCount: tokens.totalTokens
    }
  }));
}

async function listen(handler: import("node:http").RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  return server;
}

function originOf(server: import("node:http").Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback server has no port");
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

function closeServer(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
