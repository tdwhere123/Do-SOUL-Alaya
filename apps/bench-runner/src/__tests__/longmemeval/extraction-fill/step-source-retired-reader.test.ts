import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from
  "../../../runs/extraction/authority/inspection.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from
  "../../../runs/extraction/authority/receipt.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { inspectCachedSourceSemantic } from
  "../../../runs/extraction/cache/source-semantic-artifact.js";
import { inspectInteractiveTransportEvidence } from "../../../runs/extraction/cache/source-interactive-binding.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { parseSourceSemanticInteractivePreflight, preflightSourceSemanticInteractive } from
  "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";
import {
  authoredStepHttpWire,
  writeAuthoredRetiredStepArtifact
} from "./historical-extraction-test-support.js";

const MODEL = "step-3.5-flash-2603";
const PROFILE = "step-3.5-2603-low-json-schema-v1";
let roots: { cacheRoot: string; dataDir: string; pinnedMetaRoot: string };
const writeDataset = registerExtractionFillHooks(value => { roots = value; }, "longmemeval_s");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function scenario() {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  await writeDataset(Array.from({ length: 3 }, (_, i) => buildExtractionFillQuestion(
    `step-q${i}`, `I completed alpha. The record is ${i}.`,
    `I completed decoy. The record is ${i}.`
  )));
  const options = { ...roots, variant: "longmemeval_s" as const,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
    concurrency: 1, log: () => undefined };
  const inspection = await inspectExtractionAuthority({ ...options,
    action: "sample", revision: readCurrentExtractionAuthorityRevision() });
  const selected = inspection.missingKeys.slice(0, 1);
  expect(selected).toHaveLength(1);
  const preflight = await preflightSourceSemanticInteractive({ ...options, cacheRoot: roots.cacheRoot,
    preflightKeys: selected });
  expect(parseSourceSemanticInteractivePreflight(JSON.parse(JSON.stringify(preflight)))).toEqual(preflight);
  const scope = createExtractionSampleScope(selected, inspection);
  const receipt = createExtractionAuthorityReceipt({ action: "sample", sampleScope: scope,
    observation: inspection.observation, inspection, maxConcurrency: 1,
    sourcePreflight: preflight,
    outputTokenCap: { field: "max_tokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
      outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const receiptPath = join(roots.cacheRoot, "step-sample-authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  return { options: { ...options, authorityReceiptPath: receiptPath }, preflight, receipt };
}

it("retired Step read uses retained outer binding", async () => {
  const fixture = await scenario();
  const extractorFactory = vi.fn(() => { throw new Error("retired producer was constructed"); });
  await expect(runExtractionFill({ ...fixture.options, extractorFactory }))
    .rejects.toThrow("retired passive generation");
  expect(extractorFactory).not.toHaveBeenCalled();

  const sourceCorpus = "I completed alpha. The record is authored-historical.";
  const rawJson = JSON.stringify({
    contract: "source-semantic-proposal-v7",
    outcome: { status: "abstained" }
  });
  const planned = fixture.preflight.planned_requests[0]!;
  const { key } = await writeAuthoredRetiredStepArtifact({
    cacheRoot: roots.cacheRoot,
    receipt: fixture.receipt,
    retainedKey: planned.key,
    unitKeys: planned.unitKeys,
    sourceCorpus,
    systemPrompt: planned.systemPrompt,
    rawJson,
    httpWire: authoredStepHttpWire(rawJson)
  });
  const shardPath = cacheFilePath(roots.cacheRoot, key);
  const shard = JSON.parse(readFileSync(shardPath, "utf8"));
  const outer = inspectInteractiveTransportEvidence(shard.source_semantic, shard, roots.cacheRoot, true);
  expect(outer).toMatchObject({ requestBinding: "unbound", admissionState: "admitted" });
  const before = readFileSync(shardPath, "utf8");
  const actual = inspectCachedSourceSemantic(roots.cacheRoot, key, MODEL, PROFILE);
  expect(readFileSync(shardPath, "utf8")).toBe(before);
  expect(actual.status).toBe("retired");
  expect(actual).toMatchObject({ eligibility: "retained_only" });
});
