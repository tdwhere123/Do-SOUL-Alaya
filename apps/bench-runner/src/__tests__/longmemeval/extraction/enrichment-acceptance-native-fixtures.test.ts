import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SOURCE_INTERPRETATION_CONTRACT,
  locateSourceInterpretation
} from "@do-soul/alaya-protocol";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  buildOfficialApiExtractionRequests,
  buildOfficialApiSourceCorpus,
  classifyOfficialApiExtractionResult,
  computeOfficialApiSourceCorpusIdentity,
  planOfficialApiSemanticWorkset,
  planOfficialApiTransport,
  receiveOfficialApiSourceInterpretations,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { bindSourceInterpretationAnchors } from "../../../runs/extraction/cache/semantic-supplement/source-interpretation-anchor-binding.js";
import { inspectSemanticArtifact } from "../../../runs/extraction/cache/semantic-artifact/store.js";
import { runSemanticFill } from "../../../runs/extraction/fill/semantic-fill-executor.js";
import {
  createOfflineSemanticEnvelope,
  createOfflineSemanticReplayForTasks
} from "../../../runs/extraction/fill/semantic-fill-envelope.js";
import type { FrozenAssertion } from "../../../runs/extraction/enrichment-acceptance/frozen-population.js";
import { bindFrozenPopulation } from "../../../runs/extraction/enrichment-acceptance/source-binding.js";
import {
  ENRICHMENT_PREFLIGHT_CAPABILITY,
  ENRICHMENT_PREFLIGHT_MAX_OUTPUT_TOKENS,
  ENRICHMENT_PREFLIGHT_MODEL,
  ENRICHMENT_PREFLIGHT_REQUEST_PROFILE
} from "../../../runs/extraction/enrichment-acceptance/current-preflight.js";
import {
  composeEnrichmentPreparationReport,
  type EnrichmentBoundNativeOutcome
} from "../../../runs/extraction/enrichment-acceptance/preparation-report.js";
import {
  SEMANTIC_CAPABILITY as CAP,
  TOKEN_AWARE_POLICY,
  semanticInterpretation,
  semanticTask,
  semanticTasks
} from "./semantic-artifact-fixture.js";

const BERLIN = "I moved to Berlin.";
const TYPESCRIPT = "I prefer TypeScript.";
const REVIEW_ONLY = "review-only obligation absent from every source sentence";
const previousFetch = globalThis.fetch;

describe("enrichment acceptance native fixtures", () => {
  let root: string;
  let fetches = 0;

  beforeEach(() => {
    fetches = 0;
    root = mkdtempSync(join(tmpdir(), "enrichment-native-"));
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error("provider forbidden in enrichment acceptance fixtures");
    };
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps nonempty planner requests distinct from valid-empty catalog outcomes", () => {
    const nonempty = planOfficialApiSemanticWorkset(BERLIN, [{ role: "user", content: BERLIN }]);
    const nonemptyRequests = buildOfficialApiExtractionRequests(BERLIN, [{ role: "user", content: BERLIN }]);
    expect(nonempty.units.length).toBeGreaterThan(0);
    expect(nonemptyRequests.some((request) => request.source_assertions.length > 0)).toBe(true);

    const emptyWorkset = planOfficialApiSemanticWorkset("", []);
    const emptyRequests = buildOfficialApiExtractionRequests("", []);
    expect(emptyWorkset.units).toHaveLength(0);
    expect(emptyRequests.every((request) => request.source_assertions.length === 0)).toBe(true);
    expect(emptyRequests).not.toEqual(nonemptyRequests);
    expect(fetches).toBe(0);
  });

  it("keeps annotations and obligations out of current request bytes and captures source identities", () => {
    const workset = planOfficialApiSemanticWorkset(BERLIN, [{ role: "user", content: BERLIN }]);
    const requests = buildOfficialApiExtractionRequests(BERLIN, [{ role: "user", content: BERLIN }]);
    const corpus = buildOfficialApiSourceCorpus(BERLIN, [{ role: "user", content: BERLIN }]);
    const payload = [
      OFFICIAL_API_SYSTEM_PROMPT,
      ...requests.map((request) => stringifyOfficialApiExtractionRequest(request))
    ].join("\n");
    expect(payload.includes(REVIEW_ONLY)).toBe(false);
    expect(payload.includes("invent a subscription")).toBe(false);
    expect(payload).not.toMatch(/in_scope_durable_proposition|legitimate_abstention_candidate/u);
    expect(workset.units[0]?.binding.sourceCorpusIdentity)
      .toBe(computeOfficialApiSourceCorpusIdentity(corpus));
    expect(requests[0]?.source_corpus_identity).toBe(computeOfficialApiSourceCorpusIdentity(corpus));
    expect(SOURCE_INTERPRETATION_CONTRACT).toBe("source-interpretation-v1");
    expect(CAP).toBe("official_api_signals:v1");
    const packs = planOfficialApiTransport(workset, { kind: "reference_batch", assertionsPerPack: 1 });
    expect(packs.packs.length).toBeGreaterThan(0);
    expect(packs.packs[0]?.assertion_ids.length).not.toBe(38);
    expect(fetches).toBe(0);
  });

  it("captures model, profile and cap from the current preflight module when that graph loads", () => {
    expect(ENRICHMENT_PREFLIGHT_MODEL).toBe("gemini-3.1-flash-lite");
    expect(ENRICHMENT_PREFLIGHT_REQUEST_PROFILE).toBe("gemini-3.1-low-v1");
    expect(ENRICHMENT_PREFLIGHT_MAX_OUTPUT_TOKENS).toBe(4096);
    expect(ENRICHMENT_PREFLIGHT_CAPABILITY).toBe("official_api_signals:v1");
  });

  it("refuses older signals raw as current-contract input without fabricating interpretations", () => {
    const request = buildOfficialApiExtractionRequests(BERLIN, [{ role: "user", content: BERLIN }])[0]!;
    const sourceCorpus = buildOfficialApiSourceCorpus(BERLIN, [{ role: "user", content: BERLIN }]);
    expect(() => classifyOfficialApiExtractionResult('{"signals":[]}', request, sourceCorpus))
      .toThrow(/interpretations array/u);
    const received = receiveOfficialApiSourceInterpretations('{"signals":[]}', request, {
      sourceCorpus,
      artifactKey: "artifact-1"
    });
    expect(received.status).toBe("partial");
    expect(received.located[0]?.outcome).toBe("failed");
    expect(received.rejections[0]?.reason).toBe("malformed_response");
    expect(() => bindSourceInterpretationAnchors({
      request,
      sourceCorpus,
      assertionIds: [request.source_assertions[0]!.assertion_id],
      sourceRawJson: '{"signals":[]}',
      primaryRawJson: '{"interpretations":[]}'
    })).toThrow();
    expect(fetches).toBe(0);
  });

  it("keeps a valid sibling attributed when a packed relation is malformed", () => {
    const source = `${BERLIN} ${TYPESCRIPT}`;
    const request = buildOfficialApiExtractionRequests(source, [{ role: "user", content: source }])[0]!;
    const sourceCorpus = buildOfficialApiSourceCorpus(source, [{ role: "user", content: source }]);
    expect(request.source_assertions.length).toBeGreaterThanOrEqual(2);
    const first = request.source_assertions[0]!;
    const second = request.source_assertions[1]!;
    const firstNeedle = first.text.replace(/^(?:User|Assistant): /u, "").match(/[A-Za-z]{4,}/u)?.[0];
    expect(firstNeedle).toBeDefined();
    const received = receiveOfficialApiSourceInterpretations(JSON.stringify({
      interpretations: [
        {
          assertion_id: first.assertion_id,
          relations: [{
            predicate: { text: firstNeedle! },
            arguments: [],
            qualifiers: []
          }]
        },
        {
          assertion_id: second.assertion_id,
          relations: [{ predicate: { text: "uses" }, extra: true, arguments: [], qualifiers: [] }]
        }
      ]
    }), request, { sourceCorpus, artifactKey: "artifact-1" });
    expect(received.status).toBe("partial");
    expect(received.located).toHaveLength(2);
    expect(received.located[0]?.outcome).toBe("candidates");
    expect(received.located[1]?.outcome).toBe("failed");
    expect(received.located[0]?.candidates.length).toBeGreaterThan(0);
    const rows = [frozenRow(1, "optional", null)];
    const report = composeEnrichmentPreparationReport({
      population: { rows },
      bindings: bindFrozenPopulation(rows, { catalogUnits: [] }),
      preflight: null,
      nativeOutcomes: [emptyNativeCell(rows[0]!, {
        raw_state: "partial",
        machine_admission: "partial",
        located_outcome: "candidates",
        candidate_ordinal: 0,
        rejected_siblings: [{ candidate_ordinal: 1, reason: "invalid_candidate" }]
      })]
    });
    expect(report.source_fidelity.rows[0]?.raw_state).toBe("partial");
    expect(report.source_fidelity.rows[0]?.candidate_ordinal).toBe(0);
    expect(report.source_fidelity.rows[0]?.rejected_siblings).toEqual([
      { candidate_ordinal: 1, reason: "invalid_candidate" }
    ]);
    expect(fetches).toBe(0);
  });

  it("preserves foreign identity, unprovided unit and source revision as native partials", () => {
    const request = buildOfficialApiExtractionRequests(BERLIN, [{ role: "user", content: BERLIN }])[0]!;
    const sourceCorpus = buildOfficialApiSourceCorpus(BERLIN, [{ role: "user", content: BERLIN }]);
    const member = request.source_assertions[0]!;
    const foreign = receiveOfficialApiSourceInterpretations(JSON.stringify({
      interpretations: [{
        assertion_id: 99,
        relations: [{ predicate: { text: "moved" }, arguments: [], qualifiers: [] }]
      }]
    }), request, { sourceCorpus, artifactKey: "artifact-1" });
    expect(foreign.status).toBe("partial");
    expect(foreign.rejections.some((item) => item.reason === "source_assertion_mismatch")).toBe(true);
    expect(foreign.located[0]?.outcome).toBe("empty");

    const unprovided = receiveOfficialApiSourceInterpretations('{"interpretations":[]}', request, {
      sourceCorpus,
      artifactKey: "artifact-1"
    });
    expect(unprovided.located[0]?.outcome).toBe("empty");
    expect(unprovided.located[0]?.candidates).toEqual([]);
    const classifiedEmpty = classifyOfficialApiExtractionResult('{"interpretations":[]}', request, sourceCorpus);
    expect(classifiedEmpty.status).toBe("completed_empty");

    const revised = receiveOfficialApiSourceInterpretations(JSON.stringify({
      interpretations: [{
        assertion_id: member.assertion_id,
        relations: [{ predicate: { text: "moved" }, arguments: [], qualifiers: [] }]
      }]
    }), request, { sourceCorpus: `${sourceCorpus} Extra.`, artifactKey: "artifact-1" });
    expect(revised.status).toBe("partial");
    expect(revised.located).toEqual([]);
    expect(revised.rejections.every((item) => item.reason === "source_generation_mismatch")).toBe(true);
    const rows = [frozenRow(1, "optional", null)];
    const foreignPointer = {
      file: "regression-source-review.json",
      assertion_id: 99,
      request_key: "ff".repeat(32),
      canonical_index: null
    };
    const report = composeEnrichmentPreparationReport({
      population: { rows },
      bindings: bindFrozenPopulation(rows, { catalogUnits: [] }),
      preflight: null,
      nativeOutcomes: [
        emptyNativeCell(rows[0]!, {
          raw_state: "valid-empty",
          machine_admission: "valid-empty",
          located_outcome: "empty"
        }),
        {
          annotation_pointer: foreignPointer,
          request_ordinal: 0,
          candidate_ordinal: 0,
          raw_state: "rejected",
          machine_admission: "rejected",
          located_outcome: "failed"
        }
      ]
    });
    expect(report.source_fidelity.rows[0]?.raw_state).toBe("valid-empty");
    expect(report.native_formation_publication.unmatched_native_outcomes).toHaveLength(1);
    expect(report.native_formation_publication.unmatched_native_outcomes[0]?.annotation_pointer)
      .toEqual(foreignPointer);
    expect(fetches).toBe(0);
  });

  it("isolates a malformed relation ordinal without claiming complete generation", () => {
    const source = `User: ${BERLIN}`;
    const located = locateSourceInterpretation({
      source,
      artifactKey: "artifact-1",
      sha256: (value) => createHash("sha256").update(value, "utf8").digest("hex"),
      assertion: { assertion_id: 1, text: BERLIN, source_span: [6, 6 + BERLIN.length] },
      response: {
        kind: "received",
        value: {
          interpretations: [{
            assertion_id: 1,
            relations: [
              { predicate: { text: "moved" }, arguments: [], qualifiers: [] },
              { predicate: { text: "moved" }, extra: true, arguments: [], qualifiers: [] }
            ]
          }]
        }
      }
    });
    expect(located.contract).toBe(SOURCE_INTERPRETATION_CONTRACT);
    expect(located.outcome).toBe("candidates");
    expect(located.candidates).toHaveLength(1);
    expect(located.diagnostics).toEqual([{ candidate_index: 1, reason: "invalid_candidate" }]);
    expect(located.outcome).not.toBe("empty");
  });

  it("reopens a nonempty current-contract artifact from the native file cache", async () => {
    const task = semanticTask(BERLIN);
    const rawJson = JSON.stringify({ interpretations: [semanticInterpretation(task)] });
    expect(rawJson.includes('"signals"')).toBe(false);
    const report = await runSemanticFill({
      root,
      tasks: [task],
      envelope: createOfflineSemanticEnvelope({
        maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
      }),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [task], transportPolicy: TOKEN_AWARE_POLICY, result: { kind: "raw", rawJson }
      })
    });
    expect(report.admitted).toBe(1);
    const first = inspectSemanticArtifact(root, task.semanticKey, CAP);
    expect(first.status).toBe("provider_backed");
    expect(first.artifact?.capability).toBe("official_api_signals:v1");
    const digest = first.artifact?.raw_response_digest;
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    const rawPath = join(root, "raw", digest!.slice(0, 2), `${digest}.json`);
    const persisted = JSON.parse(readFileSync(rawPath, "utf8")) as { interpretations?: unknown };
    expect(Array.isArray(persisted.interpretations)).toBe(true);
    expect(persisted).not.toHaveProperty("signals");
    const reopened = inspectSemanticArtifact(root, task.semanticKey, CAP);
    expect(reopened.status).toBe("provider_backed");
    expect(reopened.artifact?.semantic_key).toBe(task.semanticKey);
    expect(fetches).toBe(0);
  });

  it("does not admit a foreign identity or source-revision replay as complete generation", async () => {
    const [berlin, paris] = semanticTasks([BERLIN, "I moved to Paris."]);
    const rawJson = JSON.stringify({
      interpretations: [semanticInterpretation(berlin!), { ...semanticInterpretation(berlin!), assertion_id: 999 }]
    });
    const report = await runSemanticFill({
      root,
      tasks: [berlin!, paris!],
      envelope: createOfflineSemanticEnvelope({
        maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
      }),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [berlin!, paris!], transportPolicy: TOKEN_AWARE_POLICY, result: { kind: "raw", rawJson }
      })
    });
    expect(report.admitted).toBe(0);
    expect(inspectSemanticArtifact(root, berlin!.semanticKey, CAP).status).toBe("missing");
    expect(inspectSemanticArtifact(root, paris!.semanticKey, CAP).status).toBe("missing");
    expect(fetches).toBe(0);
  });

  it("reports all-empty first-stage outcomes as 0/3 coverage, not a quality pass", () => {
    const rows = [
      frozenRow(1, "optional", null),
      frozenRow(2, "required", "aspiration"),
      frozenRow(4, "required", "capability"),
      frozenRow(6, "optional", "aspiration", { duplicate_of: 2 }),
      frozenRow(8, "required", "release")
    ];
    const report = composeEnrichmentPreparationReport({
      population: { rows },
      bindings: bindFrozenPopulation(rows, { catalogUnits: [] }),
      preflight: null,
      nativeOutcomes: rows.map((item) => emptyNativeCell(item)),
      fixtureOutcomes: [{
        name: "all selected outcomes empty",
        kind: "native_formation_publication",
        result: "passed",
        cell_state: "valid-empty"
      }]
    });
    expect(report.source_fidelity.first_stage_required_groups).toBe(3);
    expect(report.source_fidelity.full_required_groups).toBe(3);
    expect(report.source_fidelity.full_required_groups).not.toBe(15);
    expect(report.source_fidelity.required_group_ids.first_stage)
      .toEqual(["aspiration", "capability", "release"]);
    expect(report.source_fidelity.rows.every((item) => item.raw_state === "valid-empty")).toBe(true);
    expect(report.source_fidelity.rows.every((item) => item.machine_admission === "valid-empty")).toBe(true);
    const faithfulRequiredGroups = new Set(
      report.source_fidelity.rows
        .filter((row) => row.classification === "required" && row.human_verdict !== "unreviewed")
        .map((row) => row.required_group_id)
    );
    expect(faithfulRequiredGroups.size).toBe(0);
    expect(report.source_fidelity.human_verdicts).toBe("unreviewed");
    expect(report.native_formation_publication.status).toBe("valid-empty");
    expect(report.native_formation_publication.machine_admission).toBe("valid-empty");
    expect(report.native_formation_publication.human_verdict).toBe("unreviewed");
    expect(report.native_formation_publication.note).toMatch(/mechanism evidence only/u);
    expect(fetches).toBe(0);
  });

  it("treats a legitimate optional slogan/price empty as valid abstention, not a missing response", () => {
    const rows = [frozenRow(1, "optional", null)];
    const report = composeEnrichmentPreparationReport({
      population: { rows },
      bindings: bindFrozenPopulation(rows, { catalogUnits: [] }),
      preflight: null,
      nativeOutcomes: [emptyNativeCell(rows[0]!)],
      fixtureOutcomes: [{
        name: "optional slogan fragment empty",
        kind: "native_formation_publication",
        result: "passed",
        cell_state: "valid-empty",
        detail: "valid abstention"
      }]
    });
    expect(report.source_fidelity.rows[0]?.classification).toBe("optional");
    expect(report.source_fidelity.rows[0]?.raw_state).toBe("valid-empty");
    expect(report.source_fidelity.rows[0]?.raw_state).not.toBe("missing");
    expect(report.source_fidelity.rows[0]?.machine_admission).toBe("valid-empty");
    expect(report.native_formation_publication.status).toBe("valid-empty");
    expect(report.native_formation_publication.status).not.toBe("missing");
    expect(report.source_fidelity.rows[0]?.human_verdict).toBe("unreviewed");
    expect(report.public_consumption.status).toBe("not_exercised");
  });

  it("fails a false promisor at the quality layer even when native admission locates substrings", () => {
    const source = "In 2016 Shadow released a PC and cloud promise.";
    const request = buildOfficialApiExtractionRequests(source, [{ role: "user", content: source }])[0]!;
    const sourceCorpus = buildOfficialApiSourceCorpus(source, [{ role: "user", content: source }]);
    const member = request.source_assertions[0]!;
    const received = receiveOfficialApiSourceInterpretations(JSON.stringify({
      interpretations: [{
        assertion_id: member.assertion_id,
        relations: [{
          predicate: { text: "released" },
          arguments: [
            { role: "agent", phrase: { text: "Shadow" } },
            { role: "object", phrase: { text: "promise" } }
          ],
          qualifiers: [{ role: "time", phrase: { text: "2016" } }]
        }]
      }]
    }), request, { sourceCorpus, artifactKey: "artifact-1" });
    expect(received.located[0]?.outcome).toBe("candidates");
    const missing = receiveOfficialApiSourceInterpretations('{"interpretations":[]}', request, {
      sourceCorpus,
      artifactKey: "artifact-1"
    });
    expect(missing.located[0]?.outcome).toBe("empty");
    expect(missing.located[0]?.candidates).toEqual([]);
    const rows = [frozenRow(8, "required", "release")];
    const report = composeEnrichmentPreparationReport({
      population: { rows },
      bindings: bindFrozenPopulation(rows, { catalogUnits: [] }),
      preflight: null,
      nativeOutcomes: [emptyNativeCell(rows[0]!, {
        raw_state: "unreviewed",
        machine_admission: "unreviewed",
        located_outcome: received.located[0]?.outcome === "candidates" ? "candidates" : "empty",
        candidate_ordinal: 0
      })],
      semanticAnnotations: [{
        annotation_pointer: rows[0]!.annotation_pointer,
        quality_cell: "hold",
        attributed_to: "authored false-promisor annotation",
        detail: "product assigned as promisor"
      }],
      fixtureOutcomes: [
        {
          name: "native substring admission",
          kind: "native_formation_publication",
          result: "passed",
          cell_state: "unreviewed"
        },
        {
          name: "false promisor quality",
          kind: "source_fidelity",
          result: "failed",
          detail: "product assigned as promisor"
        }
      ]
    });
    expect(report.native_formation_publication.status).toBe("unreviewed");
    expect(report.native_formation_publication.human_verdict).toBe("unreviewed");
    expect(report.source_fidelity.rows[0]?.human_verdict).toBe("unreviewed");
    expect(report.source_fidelity.rows[0]?.quality_cell).toBe("hold");
    expect(report.source_fidelity.rows[0]?.quality_attribution)
      .toBe("authored false-promisor annotation");
    expect(report.source_fidelity.rows[0]?.raw_state).toBe("unreviewed");
    expect(report.source_fidelity.fixture_outcomes).toEqual([{
      name: "false promisor quality",
      kind: "source_fidelity",
      result: "failed",
      detail: "product assigned as promisor"
    }]);
    expect(fetches).toBe(0);
  });

  it("leaves public consumption not_exercised unless an existing consumer check ran", () => {
    const rows = [frozenRow(2, "required", "aspiration")];
    const report = composeEnrichmentPreparationReport({
      population: { rows },
      bindings: bindFrozenPopulation(rows, { catalogUnits: [] }),
      preflight: null,
      fixtureOutcomes: [{
        name: "public-consumption scorer not imported",
        kind: "public_consumption",
        result: "not_run"
      }]
    });
    expect(report.public_consumption.status).toBe("not_exercised");
    expect(report.public_consumption.note).toMatch(/not imported/u);
    expect(fetches).toBe(0);
  });

  it("does not treat mixed public pass and fail as exercised success", () => {
    const rows = [frozenRow(2, "required", "aspiration")];
    const report = composeEnrichmentPreparationReport({
      population: { rows },
      bindings: bindFrozenPopulation(rows, { catalogUnits: [] }),
      preflight: null,
      fixtureOutcomes: [
        { name: "public success", kind: "public_consumption", result: "passed" },
        { name: "public failure", kind: "public_consumption", result: "failed" }
      ]
    });
    expect(report.public_consumption.status).toBe("not_verified");
    expect(report.public_consumption.status).not.toBe("exercised");
    expect(fetches).toBe(0);
  });
});

function frozenRow(
  assertionId: number,
  classification: FrozenAssertion["classification"],
  requiredGroupId: string | null,
  overrides: Partial<FrozenAssertion> = {}
): FrozenAssertion {
  return {
    population: "regression",
    annotation_pointer: {
      file: "regression-source-review.json",
      assertion_id: assertionId,
      request_key: "aa".repeat(32),
      canonical_index: null
    },
    original_ordinal: assertionId,
    exact_text: `User: fact ${assertionId}.`,
    original_source: { exact_text: `fact ${assertionId}.` },
    occurrence: {
      source_message_ids: ["msg"],
      source_locator: null,
      source_occurrence_identity: null,
      occurrence_bindings: []
    },
    classification,
    required_group_id: requiredGroupId,
    first_stage_subset: true,
    obligations: [REVIEW_ONLY],
    forbidden: ["invent a subscription"],
    duplicate_of: null,
    participants: null,
    source_role: null,
    modality: null,
    conditions: null,
    scope: null,
    time: null,
    event_policy: null,
    ...overrides
  };
}

function emptyNativeCell(
  assertion: FrozenAssertion,
  overrides: Partial<EnrichmentBoundNativeOutcome> = {}
): EnrichmentBoundNativeOutcome {
  return {
    annotation_pointer: assertion.annotation_pointer,
    request_ordinal: 0,
    candidate_ordinal: null,
    raw_state: "valid-empty",
    machine_admission: "valid-empty",
    located_outcome: "empty",
    ...overrides
  };
}
