import { expect, it } from "vitest";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { buildOfficialApiSourceCorpus, buildOfficialApiSourceRequest } from "@do-soul/alaya-soul";
import { indexOfficialApiSourceAssertions } from
  "../../../../../../packages/soul/src/garden/triage/grounding/source-locator.js";
import { SOURCE_DISCOVERY_CANARY } from
  "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { WS, RUN } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { bindReceivedSourceInterpretationPayload, requireCompletePublicBind } from "./source-discovery-admitted-public-publication.js";
import { aggregateAdmittedUtility, runAdmittedPublicMatrix } from "./source-discovery-admitted-matrix.js";
import { awaitWorkerAfterMainSqliteClose, withBoundPublicWorker, withPlantedSourceWorker } from "./source-discovery-public-consumption-plant.js";
import { publishCorePublicSources } from "./source-discovery-native-publication.js";
import { consumePublicSources } from "./source-discovery-public-consumer.js";
import { publicSearchRequest, scoreConsumption, type ConsumptionTrace } from "./source-discovery-public-consumption.js";
import { observePublishedProposalExposure } from "./source-discovery-proposal-attribution.js";

const phrase = (text: string) => ({ text });
const role = (name: string, text: string) => ({ role: name, phrase: phrase(text) });
// Independently authored legal phrase boundaries; these are not changed query sketches.
const variants = [
  { predicate: phrase("strives to become"), arguments: [role("agent", "Shadow"),
    role("goal", "the definitive cloud platform for gamers, creatives, and businesses")],
  qualifiers: [role("reason", "because we believe that cloud technologies have the potential to bring technological freedom to all")] },
  { predicate: phrase("is"), arguments: [role("subject", "Shadow"),
    role("complement", "the easiest way to access a full PC, instantly, on all the devices you own")], qualifiers: [] },
  { predicate: phrase("was released"), arguments: [role("theme", "SHADOW’s original product")],
    qualifiers: [role("event_time", "2016"),
      role("accompanying_content", "with the promise of allowing all individuals to enjoy the power of a high-end PC from the cloud")] }
];

it("rejects a cheaper fallback matrix without published proposal exposure after SQLite reopen", async () => {
  const text = SOURCE_DISCOVERY_CANARY.map((item) => item.intended).join("\n\n") + `\n\n${"Unrelated source context. ".repeat(180)}`;
  const sourceCorpus = buildOfficialApiSourceCorpus(text, [{ role: "user", content: text }]);
  const catalog = indexOfficialApiSourceAssertions(sourceCorpus);
  const ids = SOURCE_DISCOVERY_CANARY.map((item) => catalog.find((row) => row.text.includes(item.intended))!.assertion_id);
  const request = buildOfficialApiSourceRequest(sourceCorpus, ids);
  const rawJson = JSON.stringify({ interpretations: ids.map((assertion_id, index) => ({
    assertion_id, relations: [variants[index]]
  })) });
  const bind = requireCompletePublicBind(bindReceivedSourceInterpretationPayload({
    sourceCorpus, request, rawJson, artifactKey: "authored-phrase-boundary-population"
  }));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("provider forbidden in proposal attribution regression"); };
  try {
    const matrix = await runAdmittedPublicMatrix({ bind, sourceCorpus });
    expect(matrix.failed).toEqual([]);
    expect(matrix.utility.complete).toBe(true);
    expect(matrix.utility.content_scope.every((group) => group.complete)).toBe(true);
    expect(matrix.utility.strict_improvement).toBe(true);
    expect(matrix.utility.proposal_exposure_observed).toBe(false);
    expect(matrix.utility.witnessed_paired_improvement).toBe(false);
    expect(matrix.utility.accepted).toBe(false);
    expect(matrix.utility.causal_benefit).toBe("not_established");
    const legacyRows = matrix.rows.map(({ proposal_exposure: _omitted, ...row }) => row);
    expect(aggregateAdmittedUtility(legacyRows, matrix.selected.length, false).accepted).toBe(false);
    const traces = matrix.traces as { trace: { steps: ConsumptionTrace["steps"] } }[];
    expect(traces.flatMap(({ trace }) => trace.steps).every((step) =>
      step.public_exchange.response.source_lookups.every((row) =>
        row.reasons === "unavailable" || row.reasons?.length === 0))).toBe(true);
  } finally { globalThis.fetch = previousFetch; }
}, 120_000);

it("binds an exposed proposal to its published candidate, request and source before complete reading", async () => {
  const canary = SOURCE_DISCOVERY_CANARY[1]!;
  const sourceCorpus = buildOfficialApiSourceCorpus(canary.intended, [{ role: "user", content: canary.intended }]);
  const request = buildOfficialApiSourceRequest(sourceCorpus, indexOfficialApiSourceAssertions(sourceCorpus).map((row) => row.assertion_id));
  const rawJson = JSON.stringify({ interpretations: request.source_assertions.map((row) => ({
    assertion_id: row.assertion_id, relations: [{ predicate: phrase("access"),
      arguments: [role("capability", "full PC"), role("devices", "all the devices you own")],
      qualifiers: [role("temporal", "instantly")] }]
  })) });
  await withBoundPublicWorker({ sourceBody: sourceCorpus, distractorBody: canary.distractor, rawJson, request },
    async (planted, handler, receipts, client) => {
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await awaitWorkerAfterMainSqliteClose(client);
      const search = publicSearchRequest(canary, "proposal", "source_only", "canonical");
      const trace = await consumePublicSources({ handler, receipts, request: search,
        context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" } });
      const score = scoreConsumption(canary, planted.sourceId, trace, "source_only", sourceCorpus);
      const input = { trace, firstCompleteStep: score.first_complete_step, request: search,
        bind: planted.bind, source: planted.source, workspaceId: WS };
      const observed = observePublishedProposalExposure(input);
      expect(observed.status).toBe("observed");
      expect(observed.witnesses.length).toBeGreaterThan(0);
      expect(observed.witnesses.every((witness) => witness.step_index <= score.first_complete_step!)).toBe(true);
      const first = observed.witnesses[0]!;
      expect(first.reason.source_target.root_id).toBe(planted.sourceId);
      expect(first.reason.context_id).toBe(planted.bind.receive.located[0]!.assertion_binding.context_id);

      for (const field of ["candidate_id", "context_id"] as const) {
        const mutated = rewriteReasons(trace, (reason) => ({ ...reason, [field]: "foreign" }));
        expect(observePublishedProposalExposure({ ...input, trace: mutated }).status).toBe("not_observed");
      }
      for (const field of ["root_id", "source_version", "content_digest"] as const) {
        const mutated = rewriteReasons(trace, (reason) => ({ ...reason,
          source_target: { ...reason.source_target, [field]: "foreign" } }));
        expect(observePublishedProposalExposure({ ...input, trace: mutated }).status).toBe("not_observed");
      }
      const missing = { ...trace, steps: trace.steps.map((step) => ({ ...step,
        public_exchange: { ...step.public_exchange, response: { ...step.public_exchange.response,
          source_lookups: step.public_exchange.response.source_lookups.map((row) => ({ ...row, reasons: "unavailable" as const })) } } })) };
      expect(observePublishedProposalExposure({ ...input, trace: missing }).status).toBe("not_observed");
      const late = { ...missing, steps: [...missing.steps, { ...trace.steps[first.step_index]!,
        public_exchange: { ...trace.steps[first.step_index]!.public_exchange, step_index: missing.steps.length } }] };
      expect(observePublishedProposalExposure({ ...input, trace: late }).status).toBe("not_observed");
      expect(observePublishedProposalExposure({ ...input, firstCompleteStep: null }).status).toBe("unavailable");
      const foreignRequest = { ...trace, steps: trace.steps.map((step) => ({ ...step,
        public_exchange: { ...step.public_exchange, request: { ...step.public_exchange.request, query: "foreign query" } } })) };
      expect(observePublishedProposalExposure({ ...input, trace: foreignRequest }).status).toBe("not_observed");
      const unknownReceipts = { ...trace, steps: trace.steps.map((step) => ({ ...step,
        public_exchange: { ...step.public_exchange, receipt: "unavailable" as const } })) };
      expect(observePublishedProposalExposure({ ...input, trace: unknownReceipts }).status).toBe("unavailable");
    });
}, 90_000);

function rewriteReasons(trace: ConsumptionTrace,
  rewrite: (reason: import("./source-discovery-proposal-attribution.js").ProposalExposure["witnesses"][number]["reason"]) =>
    import("./source-discovery-proposal-attribution.js").ProposalExposure["witnesses"][number]["reason"]): ConsumptionTrace {
  return { ...trace, steps: trace.steps.map((step) => ({ ...step,
    public_exchange: { ...step.public_exchange, response: { ...step.public_exchange.response,
      source_lookups: step.public_exchange.response.source_lookups.map((row) => ({ ...row,
        reasons: row.reasons === "unavailable" ? row.reasons : row.reasons?.map(rewrite) })) } } })) };
}

it("retains source lookup witnesses from Core publication across SQLite reopen and the public worker", async () => {
  const canary = SOURCE_DISCOVERY_CANARY[1]!;
  const text = `Résumé 🙂 — ${canary.intended}`;
  const sourceCorpus = buildOfficialApiSourceCorpus(text, [{ role: "user", content: text }]);
  const request = buildOfficialApiSourceRequest(sourceCorpus, indexOfficialApiSourceAssertions(sourceCorpus).map((row) => row.assertion_id));
  const rawJson = JSON.stringify({ interpretations: request.source_assertions.map((row) => ({
    assertion_id: row.assertion_id, relations: [{ predicate: phrase("access"),
      arguments: [role("capability", "full PC"), role("devices", "all the devices you own")],
      qualifiers: [role("temporal", "instantly")] }]
  })) });
  const artifactKey = "native-publication-source";
  const bind = requireCompletePublicBind(bindReceivedSourceInterpretationPayload({ sourceCorpus, request, rawJson, artifactKey }));
  await withPlantedSourceWorker(sourceCorpus, canary.distractor, async (planted) => ({
    published: await publishCorePublicSources({ database: planted.database, bind, workspaceId: WS, runId: RUN,
      now: "2026-09-06T12:00:00.000Z" })
  }), async (planted, handler, receipts, client) => {
    expect(planted.published).toHaveLength(1);
    expect(planted.published[0]!.bound.source_target.span).toBeDefined();
    expect(planted.published[0]!.bound.source_target.evidence_object_id).toBeNull();
    expect(planted.published[0]!.memory.evidence_refs).toContain(planted.published[0]!.evidence.object_id);
    expect(planted.published[0]!.bound.candidates[0]!.predicate.source_span[0])
      .toBe(Buffer.byteLength(sourceCorpus.slice(0, sourceCorpus.indexOf("access")), "utf8"));
    planted.database.close();
    closeCachedDatabase(planted.filename);
    await awaitWorkerAfterMainSqliteClose(client);
    const search = publicSearchRequest(canary, "proposal", "source_only", "canonical");
    const trace = await consumePublicSources({ handler, receipts, request: search,
      context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" } });
    const score = scoreConsumption(canary, planted.sourceId, trace, "source_only", sourceCorpus);
    const reasons = trace.steps.flatMap((step) => step.public_exchange.response.source_lookups
      .flatMap((row) => row.reasons === "unavailable" ? [] : row.reasons ?? []));
    expect(reasons.length).toBeGreaterThan(0);
    const exposureInput = { trace, firstCompleteStep: score.first_complete_step,
      request: search, bind, source: planted.source, workspaceId: WS,
      publications: planted.published.map((row) => row.bound) };
    expect(observePublishedProposalExposure(exposureInput).status).toBe("observed");
    for (const end of [1, Buffer.byteLength(sourceCorpus, "utf8") + 1]) {
      const mutated = rewriteReasons(trace, (reason) => ({ ...reason,
        source_target: { ...reason.source_target, span: { ...reason.source_target.span!,
          content_start: 0, content_end: end } } }));
      expect(observePublishedProposalExposure({ ...exposureInput, trace: mutated }).status).toBe("not_observed");
    }
  }, { sourceId: artifactKey });
}, 90_000);
