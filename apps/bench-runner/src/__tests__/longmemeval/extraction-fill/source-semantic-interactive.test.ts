import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseSourceSemanticRequest } from "@do-soul/alaya-soul";
import { runCli } from "../../../cli/cli.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import type { LongMemEvalExpansionCapability } from "../../../datasets/longmemeval/promotion/expansion/expansion-capability.js";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";

const MODEL = "gemini-2.5-flash-lite";
const REQUEST_PROFILE = "gemini-2.5-nonthinking-v1" as const;
const VARIANT = "longmemeval_s" as const;
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), VARIANT);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function authoredResponse(userPrompt: string, mode: "semantic" | "unknown_alias" = "semantic") {
  const request = parseSourceSemanticRequest(JSON.parse(userPrompt));
  const assertion = request.source_request.source_assertions.find((row) => row.text.includes("completed"))!;
  const catalog = request.source_catalog.assertions.find((row) => row.assertion_id === assertion.assertion_id)!;
  const segment = (text: string) => catalog.segments.find((row) => row.text === text)!;
  const anchor = (text: string) => ({
    assertion_id: assertion.assertion_id, source_ref: { first: segment(text).id, last: segment(text).id }
  });
  const theme = assertion.text.includes("alpha") ? "alpha" : "decoy";
  const contract = request.source_request.proposal_contract ?? "source-semantic-proposal-v3";
  const envelope = contract === "source-semantic-proposal-v4" ? {
    contract, outcome: { status: "interpreted" }, content: {
      roots: [{ act: "assertion", expression: {
        kind: "statement", predicate: { kind: "explicit", reading: "complete", at: segment("completed").id },
        arguments: [{ role: "theme", target: { key: "r0", at: segment(theme).id } }]
      } }]
    }
  } : {
    contract: "source-semantic-proposal-v3",
    outcome: { status: "interpreted" },
    content: {
      roots: [{ act: "assertion", expression: {
        kind: "statement", key: "f0", predicate: { kind: "explicit", reading: "complete", evidence: [anchor("completed")] },
        arguments: [{ role: "theme", target: { kind: "entity", key: "r0", referent_kind: "grouped", mentions: [anchor(theme)] }, evidence: [anchor(theme)] }]
      } }],
      gaps: []
    }
  };
  const editable = JSON.parse(JSON.stringify(envelope));
  if (mode === "unknown_alias") editable.content.roots[0].expression.arguments[0].target = { kind: "reference", key: segment(theme).id };
  return JSON.stringify(editable);
}

async function setupInteractive(mode: "semantic" | "unknown_alias" = "semantic") {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  await writeDataset([buildExtractionFillQuestion("q0",
    "I completed alpha. The room was quiet. The desk was clear. The lamp was on. The window was open. " +
    "The door was closed. The shelf was full. The clock was ticking. The floor was clean. It is ready.",
    "I completed decoy.")]);
  const inspection = await inspectExtractionAuthority({
    variant: VARIANT, cacheRoot, dataDir, pinnedMetaRoot, sourcePacking: "complete-source",
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, revision: readCurrentExtractionAuthorityRevision(),
    action: "fill"
  });
  const receipt = createExtractionAuthorityReceipt({
    action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 },
    inspection
  });
  const receiptPath = join(cacheRoot, "authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("batchGenerateContent") || path.startsWith("/v1beta/batches/") || path.includes("/upload")) {
      throw new Error(`interactive fill must not dispatch Batch ${path}`);
    }
    if (!path.endsWith(":streamGenerateContent")) throw new Error(`unexpected offline request ${path}`);
    const userPrompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    return Response.json({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: authoredResponse(userPrompt, mode) }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, receiptPath, keys: inspection.missingKeys };
}

it("fills complete-source open semantics through interactive generateContent without Batch isolation or packing-size errors", async () => {
  const fixture = await setupInteractive();
  expect(await runCli([
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath
  ])).toBe(0);
  expect(existsSync(join(cacheRoot, "gemini-batch-plan.json"))).toBe(false);
  expect(fixture.fetchMock).toHaveBeenCalled();
  expect(fixture.keys.length).toBeGreaterThan(0);
  const key = fixture.keys[0]!;
  expect(inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE)).toMatchObject({
    status: "hit", sourceBinding: "unbound"
  });
  const shard = JSON.parse(readFileSync(cacheFilePath(cacheRoot, key), "utf8")) as {
    readonly source_semantic: {
      readonly kind: string;
      readonly result: { readonly provenance: { readonly transport: string; readonly job?: string } };
    };
  };
  expect(shard.source_semantic.kind).toBe("gemini_generate_content");
  expect(shard.source_semantic.result.provenance.transport).toBe("gemini-generate-content");
  expect(shard.source_semantic.result.provenance.job).toBeUndefined();
  expect(JSON.stringify(shard)).not.toMatch(/batches\//u);
}, 60000);

it("quarantines an interactive generateContent line through the same source-semantic receiver as Batch", async () => {
  const fixture = await setupInteractive("unknown_alias");
  expect(await runCli([
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath
  ])).toBe(0);
  for (const key of fixture.keys) {
    const inspected = inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE);
    expect(inspected.status).not.toBe("hit");
  }
  expect(existsSync(join(cacheRoot, "gemini-batch-plan.json"))).toBe(false);
}, 60000);

it("records an interactive generateContent network failure on the attempt ledger", async () => {
  const fixture = await setupInteractive();
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: new Error("socket hang up") });
  }));
  expect(await runCli([
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics",
    "--extraction-source-packing", "complete-source", "--extraction-authority", fixture.receiptPath
  ])).toBe(2);
  const ledgerName = readdirSync(cacheRoot).find((name) => name.startsWith("extraction-attempt-ledger"));
  expect(ledgerName).toBeDefined();
  const ledger = JSON.parse(readFileSync(join(cacheRoot, ledgerName!), "utf8")) as {
    readonly successful_shards: unknown[];
    readonly transport_failures: readonly unknown[];
  };
  expect(ledger.successful_shards).toEqual([]);
  expect(ledger.transport_failures.length).toBeGreaterThan(0);
}, 60000);

it("still refuses mixing lazy_field, expansion, or an injected extractor with open semantics", async () => {
  await expect(runExtractionFill({
    variant: VARIANT, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, cacheRoot,
    extractorFactory: () => ({ extract: async () => { throw new Error("unused"); } })
  })).rejects.toThrow(/cannot mix lazy_field, expansion, or an injected extractor/u);
  await expect(runExtractionFill({
    variant: VARIANT, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, cacheRoot,
    ingestionMode: "lazy_field", semanticArtifactRoot: join(cacheRoot, "semantic")
  })).rejects.toThrow(/cannot mix lazy_field, expansion, or an injected extractor/u);
  await expect(runExtractionFill({
    variant: VARIANT, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, cacheRoot,
    expansionCapability: {} as LongMemEvalExpansionCapability
  })).rejects.toThrow(/cannot mix lazy_field, expansion, or an injected extractor/u);
});
