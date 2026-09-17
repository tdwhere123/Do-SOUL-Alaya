import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiInterpretationAdmissionError,
  buildOfficialApiExtractionRequest,
  buildOfficialApiSourceCorpus,
  parseOfficialApiExtractionRequest,
  receiveOfficialApiSourceInterpretations,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  ExtractionResponseAdmissionError,
  computeCacheKey,
  importExtractionResponse,
  inspectCachedExtraction
} from "../../../runs/compile-seed/compile-seed-cache.js";
import { acquireExtractionCacheWriteLease } from
  "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  TEST_PROVIDER_COMPLETION_METADATA,
  writeExtractionCacheTestManifest
} from "./extraction-cache-test-fixture.js";
import {
  composeEnrichmentPreparationReport
} from "../../../runs/extraction/enrichment-acceptance/preparation-report.js";
import {
  locatePackedRequestInterpretations,
  nativeOutcomesFromInterpretationReceive
} from "../../../runs/extraction/enrichment-acceptance/interpretation-admission-outcomes.js";
import { decodeGeminiGenerateContent } from
  "../../../runs/extraction/fill/batch/native-codec.js";
import { bindFrozenPopulation } from "../../../runs/extraction/enrichment-acceptance/source-binding.js";
import type { FrozenAssertion } from "../../../runs/extraction/enrichment-acceptance/frozen-population.js";


const MODEL = "test-model";
const PROFILE = "provider-default-v1" as const;
const previousFetch = globalThis.fetch;
let root: string;
let fetches = 0;

describe("interpretation admission diagnostics", () => {
  beforeEach(() => {
    fetches = 0;
    root = mkdtempSync(join(tmpdir(), "alaya-admission-diagnostics-"));
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error("provider forbidden in admission diagnostics");
    };
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it("adapts structured locator refusals without writing a completed shard", () => {
    const source = "we planned work because we needed time.";
    const request = buildOfficialApiExtractionRequest(source, []);
    const sourceCorpus = buildOfficialApiSourceCorpus(source, []);
    const rawJson = JSON.stringify({
      interpretations: [{
        assertion_id: 1,
        relations: [{ predicate: { text: "we" }, arguments: [], qualifiers: [] }]
      }]
    });
    const userPrompt = stringifyOfficialApiExtractionRequest(request);
    const expectedCacheKey = computeCacheKey(MODEL, PROFILE, OFFICIAL_API_SYSTEM_PROMPT, userPrompt);
    writeExtractionCacheTestManifest({
      cacheRoot: root, model: MODEL, systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const lease = acquireExtractionCacheWriteLease(root);
    try {
      expect(() => importExtractionResponse({
        config: {
          model: MODEL,
          modelFamily: MODEL,
          providerUrl: TEST_EXTRACTION_PROVIDER_URL,
          requestProfile: PROFILE
        },
        cacheRoot: root,
        writeLease: lease,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        userPrompt,
        expectedCacheKey,
        sourceCorpus,
        result: { rawJson, responseMetadata: TEST_PROVIDER_COMPLETION_METADATA }
      })).toThrow(ExtractionResponseAdmissionError);
      try {
        importExtractionResponse({
          config: {
            model: MODEL,
            modelFamily: MODEL,
            providerUrl: TEST_EXTRACTION_PROVIDER_URL,
            requestProfile: PROFILE
          },
          cacheRoot: root,
          writeLease: lease,
          systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
          userPrompt,
          expectedCacheKey,
          sourceCorpus,
          result: { rawJson, responseMetadata: TEST_PROVIDER_COMPLETION_METADATA }
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ExtractionResponseAdmissionError);
        const admission = error as ExtractionResponseAdmissionError;
        expect(admission.message).toBe("provider response failed request-bound admission");
        expect(admission.cause).toBeInstanceOf(OfficialApiInterpretationAdmissionError);
        expect(admission.rejections[0]).toMatchObject({
          assertion_id: 1,
          candidate_index: 0,
          diagnostic_reason: "ambiguous"
        });
        expect(admission.receive?.located[0]?.outcome).toBe("failed");
      }
      expect(inspectCachedExtraction(root, expectedCacheKey, MODEL, PROFILE).status).toBe("missing");
      expect(fetches).toBe(0);
    } finally {
      lease.release();
    }
  });

  it("reports a quarantined first-stage request with per-assertion locator diagnostics", () => {
    const source = "we planned work because we needed time.";
    const request = buildOfficialApiExtractionRequest(source, []);
    const sourceCorpus = buildOfficialApiSourceCorpus(source, []);
    const member = request.source_assertions[0];
    expect(member).toBeDefined();
    const rawJson = JSON.stringify({
      interpretations: [{
        assertion_id: member!.assertion_id,
        relations: [{ predicate: { text: "we" }, arguments: [], qualifiers: [] }]
      }]
    });
    const received = receiveOfficialApiSourceInterpretations(rawJson, request, {
      sourceCorpus, artifactKey: "retained"
    });
    expect(received.status).toBe("partial");
    expect(received.located[0]?.diagnostics).toEqual([{ candidate_index: 0, reason: "ambiguous" }]);
    const rows = Array.from({ length: 38 }, (_, index) => frozenRow(index + 1, index < 8));
    const requestKey = "aa".repeat(32);
    const outcomes = nativeOutcomesFromInterpretationReceive({
      requestKey,
      receive: received,
      attributions: [{
        annotation_pointer: rows[5]!.annotation_pointer,
        current_assertion_id: member!.assertion_id
      }]
    });
    const sixthMapped = outcomes.find((item) => item.current_assertion_id === member!.assertion_id);
    expect(sixthMapped).toMatchObject({
      candidate_ordinal: 0,
      diagnostic_reason: "ambiguous",
      located_outcome: "failed"
    });
    const pointerOutcomes = outcomes.flatMap((item) => {
      if (item.annotation_pointer === undefined) return [];
      return [Object.freeze({
        annotation_pointer: item.annotation_pointer,
        request_ordinal: item.request_ordinal,
        candidate_ordinal: item.candidate_ordinal,
        raw_state: item.raw_state,
        machine_admission: item.machine_admission,
        located_outcome: item.located_outcome,
        ...(item.diagnostic_reason === undefined ? {} : { diagnostic_reason: item.diagnostic_reason }),
        rejected_siblings: item.rejected_siblings
      })];
    });
    const report = composeEnrichmentPreparationReport({
      population: { rows },
      bindings: bindFrozenPopulation(rows, { catalogUnits: [] }),
      preflight: null,
      selectedStage: "first_stage",
      nativeOutcomes: pointerOutcomes,
      fixtureOutcomes: [{
        name: "actual-model public consumption",
        kind: "public_consumption",
        result: "not_run",
        cell_state: "not_exercised"
      }]
    });
    const assertionSix = report.source_fidelity.rows.find((row) => row.original_ordinal === 6);
    expect(assertionSix?.native_cells[0]).toMatchObject({
      candidate_ordinal: 0,
      diagnostic_reason: "ambiguous",
      located_outcome: "failed",
      machine_admission: "rejected"
    });
    expect(report.source_fidelity.rows.slice(8).every((row) =>
      row.selected === false && row.raw_state === "not_exercised")).toBe(true);
    expect(report.native_formation_publication.machine_admission).toBe("rejected");
    expect(report.public_consumption.status).toBe("not_exercised");
    expect(fetches).toBe(0);
  });

  it("reopens assertion-local diagnostics from the retained paid response", () => {
    const paid = readRetainedPaidWindow();
    if (paid === null) return;
    const located = locatePackedRequestInterpretations({
      rawJson: paid.rawJson,
      request: paid.request,
      artifactKey: "retained-paid"
    });
    const assertionSix = located.find((row) => row.assertion_binding.assertion_id === 6);
    expect(assertionSix?.outcome).toBe("failed");
    expect(assertionSix?.diagnostics).toEqual([{ candidate_index: 0, reason: "ambiguous" }]);
    expect(paid.outputSha256).toBe(
      "b13a3d57ae50c8fa8eecc7c036da7d1c610a01dfd226f8bd259b16cdd05567e0"
    );
    expect(fetches).toBe(0);
  });
});

function frozenRow(ordinal: number, firstStage: boolean): FrozenAssertion {
  return {
    population: "regression",
    annotation_pointer: {
      file: "regression-source-review.json",
      assertion_id: ordinal,
      request_key: "bb".repeat(32),
      canonical_index: null
    },
    original_ordinal: ordinal,
    exact_text: `text-${ordinal}`,
    original_source: { exact_text: `text-${ordinal}` },
    occurrence: {
      source_message_ids: [],
      source_locator: null,
      source_occurrence_identity: null,
      occurrence_bindings: []
    },
    classification: ordinal === 2 || ordinal === 4 || ordinal === 8 ? "required" : "optional",
    required_group_id: ordinal === 2 || ordinal === 6 ? "aspiration"
      : ordinal === 4 ? "capability"
        : ordinal === 8 ? "release"
          : null,
    first_stage_subset: firstStage,
    obligations: [],
    forbidden: [],
    duplicate_of: ordinal === 6 ? 2 : null,
    participants: null,
    source_role: null,
    modality: null,
    conditions: null,
    scope: null,
    time: null,
    event_policy: null
  };
}

const RETAINED_PAID_CACHE =
  "/home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/associative-field-enrichment-readiness-20260914/first-stage-enrichment-canary/paid-eight-01/cache";
const RETAINED_PAID_JOB = "556a08d8ab9630951c942167fc4de6fd38764fd945b204d52c561c187b1bb1a7";

function readRetainedPaidWindow(): {
  readonly rawJson: string;
  readonly request: ReturnType<typeof parseOfficialApiExtractionRequest>;
  readonly outputSha256: string;
} | null {
  const outputPath = join(RETAINED_PAID_CACHE, `batch-output-${RETAINED_PAID_JOB}.jsonl`);
  const inputPath = join(RETAINED_PAID_CACHE, `batch-input-${RETAINED_PAID_JOB}.jsonl`);
  if (!existsSync(outputPath) || !existsSync(inputPath)) return null;
  const outputBytes = readFileSync(outputPath);
  const outputLine = JSON.parse(outputBytes.toString("utf8").trim().split("\n")[0]!) as {
    readonly response?: unknown;
  };
  const inputLine = JSON.parse(readFileSync(inputPath, "utf8").trim().split("\n")[0]!) as {
    readonly request?: {
      readonly contents?: readonly {
        readonly parts?: readonly { readonly text?: string }[];
      }[];
    };
  };
  const userPrompt = inputLine.request?.contents?.[0]?.parts?.[0]?.text;
  if (typeof userPrompt !== "string") return null;
  return {
    rawJson: decodeGeminiGenerateContent(outputLine.response).rawJson,
    request: parseOfficialApiExtractionRequest(JSON.parse(userPrompt) as unknown),
    outputSha256: createHash("sha256").update(outputBytes).digest("hex")
  };
}
