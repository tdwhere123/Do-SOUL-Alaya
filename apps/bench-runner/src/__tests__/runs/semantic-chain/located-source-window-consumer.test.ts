import { afterAll, afterEach, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});

afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  SoulInterpretationResponseSchema, sourceReferenceResolver, type SourceReferenceCatalog,
  type SourceSemanticDraft
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT, indexSourceSemanticUnits,
  type SourceSemanticCorrespondenceRequest
} from "@do-soul/alaya-soul";
import { CLOCK, WS, withAccessLibrary } from
  "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-access.test-support.js";
import { assessmentForTestPairs } from "../../support/semantic-correspondence-assessment.js";
import { interpretedQueryRaw } from "../../longmemeval/query-producer-fixture.js";
import { syntheticGeminiBody } from "../semantic-proposal/gemini-response-evidence.test-support.js";
import { STEP_OPENAPI_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { parseSemanticProposalWorkset, materializeSemanticProposalLines } from "../../../runs/semantic-proposal/workset.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { admitSemanticChainReplay, replaySemanticChain } from "../../../runs/semantic-chain/replay.js";
import { admitConsumerPreparation, prepareSemanticChainConsumer } from "../../../runs/semantic-chain/consumer/input.js";

const PREFIX = `${"序文🙂".repeat(600)}。\n`;
const WINDOW = "Project Aster was completed.";
const SOURCE = `${PREFIX}${WINDOW}`;
const WINDOW_START = Buffer.byteLength(PREFIX);
const WINDOW_END = WINDOW_START + Buffer.byteLength(WINDOW);
const ORIGINAL_QUERY = "Was something completed?";
const OUTPUT_BYTE_LIMIT = 11_000;
const RUN_ID = "run-1";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function windowDraft(catalog: SourceReferenceCatalog): SourceSemanticDraft {
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  const window = catalog.assertions.find(row => row.segments.map(segment => segment.text).join("").includes("Project Aster"));
  if (window === undefined) throw new Error("authored window assertion is absent from the catalog");
  const text = window.segments.map(segment => segment.text).join("");
  // Catalog selection uses local UTF-16 offsets; delivered source spans use UTF-8 bytes.
  return {
    contract: "source-interpretation-v4",
    mentions: [{ id: "mComplete", assertion_id: window.assertion_id,
      source_ref: resolver.referenceForSpan(window.assertion_id, [0, text.length]) }],
    referents: [],
    frames: [{
      id: "fComplete", assertion_ids: [window.assertion_id],
      context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: [],
      predicate_support: { kind: "explicit", reading: "completed", mentions: ["mComplete"] },
      slots: [], bindings: []
    }],
    operators: [], gaps: []
  };
}

function syntheticExtract(rawJson: string) {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  return { rawJson, responseMetadata: { finishReason: "STOP" as const }, usage,
    responseBody: syntheticGeminiBody(rawJson, "STOP", usage) };
}

async function sealLiveDatabase(livePath: string, snapshotPath: string): Promise<void> {
  const live = new BetterSqlite3(livePath, { fileMustExist: true });
  try {
    live.pragma("wal_checkpoint(TRUNCATE)");
    await live.backup(snapshotPath);
  } finally { live.close(); }
}

it("admits a Field-located non-prefix source-only window and preserves it through consumer readmission", async () => {
  const unit = indexSourceSemanticUnits(SOURCE).find(row => row.text.includes("Project Aster"));
  if (unit === undefined) throw new Error("authored source did not isolate the window unit");
  expect(Buffer.byteLength(SOURCE.slice(0, unit.start))).toBe(WINDOW_START);
  expect(WINDOW_START).toBeGreaterThan(4096);
  expect(WINDOW_END).toBe(WINDOW_START + Buffer.byteLength(WINDOW));

  const root = mkdtempSync(join(tmpdir(), "located-source-window-"));
  roots.push(root);
  const snapshotPath = join(root, "library.sqlite");
  await withAccessLibrary([
    { id: "located-window/document-00", text: SOURCE, verbatim: true, authoredDraft: windowDraft },
    { id: "located-window/document-01", text: "Unrelated cargo note.", verbatim: true }
  ], async setup => { await sealLiveDatabase(setup.filename, snapshotPath); });

  const queryWorkset = parseSemanticProposalWorkset({
    contract: "source-semantic-proposal-workset-v3", provider_url: "http://127.0.0.1:9",
    kind: "query", model: "gemini-2.5-flash-lite", request_profile: "gemini-2.5-nonthinking-v1",
    items: [{ original_query: ORIGINAL_QUERY }]
  });
  const queryCache = join(root, "queries");
  const queryAuthority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(queryWorkset, queryCache, 4096),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const queryFill = await executeSemanticProposalFill({
    workset: queryWorkset, cacheRoot: queryCache, authority: queryAuthority,
    config: { providerUrl: "http://127.0.0.1:9", model: queryWorkset.model,
      requestProfile: "gemini-2.5-nonthinking-v1", apiKey: "fixture" },
    extractor: { extract: async () => syntheticExtract(interpretedQueryRaw({
      contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, alternatives: [{ conditions: [{
        kind: "statement", key: "complete", predicate: "completed", arguments: []
      }] }], gaps: []
    })) }
  });
  expect(queryFill.newly_admitted).toBe(1);

  const chainRoot = join(root, "chain");
  const plan = await prepareSemanticChain({
    snapshot_path: snapshotPath, snapshot_sha256: hashRegularFileNoFollow(snapshotPath),
    implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: CLOCK,
    workspace_id: WS, run_id: RUN_ID, query_workset: queryWorkset, query_cache_root: queryCache,
    correspondence_cache_root: join(root, "correspondences"), max_output_tokens: 4096,
    discovery_page_cap: 4, correspondence_pair_cap: 1, access_policy: "query-conditioned-v1",
    budget: { schema_version: 1, work_units: 1_000_000, memory_bytes: 60_000_000,
      page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 },
    authorized_scopes: { mode: "named", scopes: ["project"] }, output_byte_limit: OUTPUT_BYTE_LIMIT
  }, chainRoot);
  const ready = plan.queries[0];
  if (ready?.status !== "ready") throw new Error(`query was not ready: ${JSON.stringify(ready)}`);
  expect(ready.descriptors.some(row => row.interpretation !== undefined)).toBe(true);
  expect(plan.correspondence_workset?.items.length).toBeGreaterThan(0);

  const correspondenceCache = plan.config.correspondence_cache_root;
  const workset = plan.correspondence_workset!;
  const request = materializeSemanticProposalLines(workset, 4096)[0]!.request as SourceSemanticCorrespondenceRequest;
  const interpretation = request.source_interpretation_descriptors[0]!.interpretation;
  const predicate = request.catalog!.query_endpoints.find(row => row.kind === "predicate")!;
  const frame = request.catalog!.source_endpoints.find(row => row.kind === "frame")!;
  const support = interpretation.frames[0]!.predicate_support;
  const windowLocation = interpretation.source.assertion_locations?.find(row => row.assertion_id ===
    interpretation.frames[0]!.assertion_ids[0]);
  expect(windowLocation?.source_utf8_span).toEqual([WINDOW_START, WINDOW_END]);
  const correspondenceAuthority = pinSemanticProposalAuthority({
    preflight: prepareSemanticProposal(workset, correspondenceCache, 4096),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2
  });
  const correspondenceFill = await executeSemanticProposalFill({
    workset, cacheRoot: correspondenceCache, authority: correspondenceAuthority,
    config: { providerUrl: "http://127.0.0.1:9", model: workset.model,
      requestProfile: "gemini-2.5-nonthinking-v1", apiKey: "fixture" },
    extractor: { extract: async () => syntheticExtract(JSON.stringify({
      contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
      outcome: { status: "interpreted" },
      semantic_correspondence: {
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT,
        source_interpretation_handle: "source1",
        assessments: assessmentForTestPairs(request.catalog, request.original_query, [
          { query: predicate.handle, source: frame.handle, query_excerpt: "completed",
            source_semantic_support: support.kind === "explicit" ? [{ kind: "lexical", mentions: support.mentions }] : [] }
        ])
      }
    })) }
  });
  expect(correspondenceFill.newly_admitted).toBe(1);

  const replay = await replaySemanticChain(chainRoot);
  const admitted = admitSemanticChainReplay(chainRoot, replay.path);
  const row = admitted.replay.rows.find(candidate => candidate.query_key === ready.query_key);
  if (row?.status !== "replayed") throw new Error(`native replay was not admitted: ${JSON.stringify(row)}`);
  const response = SoulInterpretationResponseSchema.parse(row.response);
  if (response.operation !== "recall") throw new Error("native recall required");
  expect(response.proofs ?? []).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(OUTPUT_BYTE_LIMIT);
  expect(response.results?.every(result => result.budget_state.within_budget)).toBe(true);
  const delivered = response.results?.find(result => result.target.kind === "source_evidence"
    && result.target.span?.content_start === WINDOW_START);
  expect(delivered).toMatchObject({
    content_preview: WINDOW,
    target: { kind: "source_evidence",
      span: { content_start: WINDOW_START, content_end: WINDOW_END, content_complete: false } }
  });
  expect(Buffer.from(SOURCE).subarray(WINDOW_START, WINDOW_END).toString("utf8")).toBe(WINDOW);
  const slotIndex = response.results!.indexOf(delivered!);
  const entry = response.index?.entries[slotIndex];
  expect(entry).toMatchObject({ claim: "unknown", explanation_ids: [] });
  expect(entry).not.toHaveProperty("interpretation_node");
  expect(entry?.target).not.toHaveProperty("interpretation_node");
  const qualifiers = response.slot_qualifiers?.filter(qualifier => qualifier.index === slotIndex);
  expect(qualifiers).toHaveLength(1);
  expect(qualifiers![0]).toMatchObject({ evidence_kind: "source_evidence", payload_support: "envelope_budget" });
  expect(qualifiers![0]).not.toHaveProperty("witnesses");
  expect(qualifiers![0]).not.toHaveProperty("support");

  const preparation = prepareSemanticChainConsumer({
    chainRoot, replayPath: replay.path, queryKey: ready.query_key,
    consumerConfig: {
      model: STEP_OPENAPI_QUOTE_BASIS.selected_model, provider_url: "https://api.stepfun.com/v1",
      request_profile: "step-3.5-2603-low-json-schema-v1", max_output_tokens: 128,
      arms: ["native_delivery"]
    }
  }, join(root, "consumer"));
  expect(preparation.provider_calls).toBe(0);
  const readmitted = admitConsumerPreparation(preparation.output_root);
  const line = readmitted.lines.find(candidate => candidate.arm === "native_delivery");
  const evidence = JSON.parse(line!.userPrompt).evidence;
  expect(evidence).toEqual(response);
  expect(evidence.results[slotIndex].content_preview).toBe(WINDOW);
  expect(evidence.results[slotIndex].target.span).toMatchObject({
    content_start: WINDOW_START, content_end: WINDOW_END
  });
  expect(evidence.proofs ?? []).toEqual([]);
  expect(isolation.violations).toEqual([]);
}, 120_000);
