import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiInterpretationAdmissionError,
  buildOfficialApiExtractionRequest,
  buildOfficialApiSourceCorpus,
  classifyOfficialApiExtractionResult,
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
  nativeOutcomesFromInterpretationReceive
} from "../../../runs/extraction/enrichment-acceptance/interpretation-admission-outcomes.js";
import { bindFrozenPopulation } from "../../../runs/extraction/enrichment-acceptance/source-binding.js";
import type { FrozenAssertion } from "../../../runs/extraction/enrichment-acceptance/frozen-population.js";
import {
  RETAINED_PAID_OUTPUT_SHA256,
  RETAINED_PAID_REQUEST_KEY,
  requireRetainedPaidExtractionWindow,
  resolveRepoRelativeArtifact
} from "./retained-paid-extraction-window.js";


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

  it("routes malformed JSON through receive into import refusal without a completed shard", () => {
    const source = "Alice uses tools.";
    const request = buildOfficialApiExtractionRequest(source, []);
    const sourceCorpus = buildOfficialApiSourceCorpus(source, []);
    const userPrompt = stringifyOfficialApiExtractionRequest(request);
    const expectedCacheKey = computeCacheKey(MODEL, PROFILE, OFFICIAL_API_SYSTEM_PROMPT, userPrompt);
    writeExtractionCacheTestManifest({
      cacheRoot: root, model: MODEL, systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    expect(() => classifyOfficialApiExtractionResult("not-json", request, sourceCorpus))
      .toThrow(OfficialApiInterpretationAdmissionError);
    try {
      classifyOfficialApiExtractionResult("not-json", request, sourceCorpus);
    } catch (error) {
      expect(error).toBeInstanceOf(OfficialApiInterpretationAdmissionError);
      const refusal = error as OfficialApiInterpretationAdmissionError;
      expect(refusal.receive.rejections[0]?.reason).toBe("malformed_response");
      expect(refusal.message).toMatch(/interpretations array/u);
    }
    const lease = acquireExtractionCacheWriteLease(root);
    try {
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
          result: { rawJson: "not-json", responseMetadata: TEST_PROVIDER_COMPLETION_METADATA }
        });
        throw new Error("expected import admission refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(ExtractionResponseAdmissionError);
        const admission = error as ExtractionResponseAdmissionError;
        expect(admission.cause).toBeInstanceOf(OfficialApiInterpretationAdmissionError);
        expect(admission.rejections[0]?.reason).toBe("malformed_response");
        expect(admission.receive?.rejections[0]?.reason).toBe("malformed_response");
        const quarantinePath = join(root, "quarantine-reopen.json");
        writeFileSync(quarantinePath, JSON.stringify({
          status: "quarantined",
          reason: admission.message,
          rejections: admission.rejections,
          receive: admission.receive
        }));
        const reopened = JSON.parse(readFileSync(quarantinePath, "utf8")) as {
          readonly rejections: readonly { readonly reason: string }[];
        };
        expect(reopened.rejections[0]?.reason).toBe("malformed_response");
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
    const persisted = join(root, "preparation-report.json");
    writeFileSync(persisted, `${JSON.stringify(report)}\n`);
    const reopened = JSON.parse(readFileSync(persisted, "utf8")) as typeof report;
    expect(reopened.source_fidelity.rows.find((row) => row.original_ordinal === 6)?.native_cells[0])
      .toMatchObject({
        candidate_ordinal: 0,
        diagnostic_reason: "ambiguous",
        located_outcome: "failed"
      });
    expect(fetches).toBe(0);
  });

  it("keeps foreign receive rejections visible in the preparation report", () => {
    const source = "Alice uses tools.";
    const request = buildOfficialApiExtractionRequest(source, []);
    const sourceCorpus = buildOfficialApiSourceCorpus(source, []);
    const received = receiveOfficialApiSourceInterpretations(JSON.stringify({
      interpretations: [
        {
          assertion_id: request.source_assertions[0]!.assertion_id,
          relations: [{ predicate: { text: "uses" }, arguments: [], qualifiers: [] }]
        },
        {
          assertion_id: 99,
          relations: [{ predicate: { text: "uses" }, arguments: [], qualifiers: [] }]
        }
      ]
    }), request, { sourceCorpus, artifactKey: "foreign-entry" });
    expect(received.status).toBe("partial");
    expect(received.rejections.some((item) => item.index_scope === "envelope" && item.assertion_id === 99))
      .toBe(true);
    const outcomes = nativeOutcomesFromInterpretationReceive({
      requestKey: "aa".repeat(32),
      receive: received,
      attributions: []
    });
    expect(outcomes.some((item) => item.current_assertion_id === 99 && item.machine_admission === "rejected"))
      .toBe(true);
    const rows = [frozenRow(1, true)];
    const report = composeEnrichmentPreparationReport({
      population: { rows },
      bindings: bindFrozenPopulation(rows, { catalogUnits: [] }),
      preflight: null,
      selectedStage: "first_stage",
      nativeOutcomes: outcomes
    });
    expect(report.native_formation_publication.unmatched_native_outcomes.some((item) =>
      item.current_assertion_id === 99 && item.machine_admission === "rejected")).toBe(true);
    expect(fetches).toBe(0);
  });

  it("replays the retained paid request, response and source through receive and reopens the stage report", () => {
    const paid = requireRetainedPaidExtractionWindow();
    expect(paid.outputSha256).toBe(RETAINED_PAID_OUTPUT_SHA256);
    const received = receiveOfficialApiSourceInterpretations(paid.rawJson, paid.request, {
      sourceCorpus: paid.sourceCorpus,
      artifactKey: "retained-paid"
    });
    expect(received.status).toBe("partial");
    const assertionSix = received.located.find((row) => row.assertion_binding.assertion_id === 6);
    expect(assertionSix?.outcome).toBe("failed");
    expect(assertionSix?.diagnostics).toEqual([{ candidate_index: 0, reason: "ambiguous" }]);
    expect(() => classifyOfficialApiExtractionResult(
      paid.rawJson, paid.request, paid.sourceCorpus
    )).toThrow(OfficialApiInterpretationAdmissionError);
    const rows = Array.from({ length: 38 }, (_, index) => frozenRow(index + 1, index < 8));
    const member = paid.request.source_assertions.find((item) => item.assertion_id === 6);
    expect(member).toBeDefined();
    const outcomes = nativeOutcomesFromInterpretationReceive({
      requestKey: RETAINED_PAID_REQUEST_KEY,
      receive: received,
      attributions: [{ 
        annotation_pointer: rows[5]!.annotation_pointer,
        current_assertion_id: member!.assertion_id
      }]
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
        cell_state: "not_exercised",
        detail: "historical quarantined payload; provenance is not cache-admitted"
      }]
    });
    expect(report.source_fidelity.rows.find((row) => row.original_ordinal === 6)?.native_cells[0])
      .toMatchObject({
        candidate_ordinal: 0,
        diagnostic_reason: "ambiguous",
        located_outcome: "failed",
        machine_admission: "rejected"
      });
    expect(report.source_fidelity.rows.slice(8).every((row) =>
      row.selected === false && row.raw_state === "not_exercised")).toBe(true);
    expect(report.public_consumption.status).toBe("not_exercised");
    const persisted = join(root, "retained-first-stage-preparation-report.json");
    writeFileSync(persisted, `${JSON.stringify(report)}\n`);
    const reopened = JSON.parse(readFileSync(persisted, "utf8")) as typeof report;
    expect(reopened.source_fidelity.rows.find((row) => row.original_ordinal === 6)?.native_cells[0])
      .toMatchObject({ candidate_ordinal: 0, diagnostic_reason: "ambiguous" });
    const evidenceDir = resolveRepoRelativeArtifact(
      ".do-it/bench-runs/associative-field-enrichment-readiness-20260914/enrichment-admission-consumption-repair"
    );
    if (evidenceDir !== null) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        join(evidenceDir, "retained-first-stage-preparation-report.json"),
        `${JSON.stringify(report)}\n`
      );
    }
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
