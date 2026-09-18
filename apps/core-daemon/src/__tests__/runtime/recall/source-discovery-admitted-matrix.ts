import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { WS, RUN, NOW } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { SOURCE_DISCOVERY_CANARY, type CanaryCase } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { consumePublicSources } from "./source-discovery-public-consumer.js";
import { PUBLIC_CONSUMPTION_PROTOCOL, publicSearchRequest, scoreConsumption } from "./source-discovery-public-consumption.js";
import { boundTrace, caseKey, missingCases, persistRunEvidence, type CaseIdentity } from "./source-discovery-public-consumption-evidence.js";
import { awaitWorkerAfterMainSqliteClose, withPlantedSourceWorker } from "./source-discovery-public-consumption-plant.js";
import { type BoundPublicReceive } from "./source-discovery-admitted-public-publication.js";
import { publishCorePublicSources } from "./source-discovery-native-publication.js";
import { observePublishedProposalExposure, type ProposalExposure } from "./source-discovery-proposal-attribution.js";

type Score = ReturnType<typeof scoreConsumption>;
type MatrixRow = CaseIdentity & { readonly state: "completed" | "failed" | "not_exercised";
  readonly score?: Score; readonly reason?: string; readonly source_id?: string;
  readonly proposal_exposure?: ProposalExposure };

export function admittedMatrixCases(): readonly CaseIdentity[] {
  return SOURCE_DISCOVERY_CANARY.flatMap((canary) =>
    (["source_only", "mixed", "memory_only"] as const).flatMap((view) =>
      (["canonical", "associative"] as const).flatMap((enumeration) =>
        (["physical-source-first", "physical-distractor-first"] as const).flatMap((cell) =>
          (["proposal", "source_text"] as const).map((lookup) => ({ cell, group: canary.group, view, enumeration, lookup }))))));
}

/** One bound population and source are held fixed for every arm; query sketches never rewrite model relations. */
export async function runAdmittedPublicMatrix(input: {
  readonly bind: BoundPublicReceive; readonly sourceCorpus: string;
  readonly evidenceDirectory?: string;
}) {
  const selected = admittedMatrixCases();
  const rows: MatrixRow[] = [];
  const noHintControls: MatrixRow[] = [];
  const traces: unknown[] = [];
  const noHintTraces: unknown[] = [];
  const completed: CaseIdentity[] = [];
  const failed: CaseIdentity[] = [];
  let fileFailed = false;
  const provenance = input.bind.status === "complete" ? input.bind.provenance : "actual-model-not-exercised";
  try {
    if (input.bind.status !== "complete") {
      for (const identity of selected) rows.push({ ...identity, state: "not_exercised", reason: input.bind.status });
      for (const identity of selected.filter((row) => row.lookup === "proposal" && row.view !== "memory_only")) {
        noHintControls.push({ ...identity, state: "not_exercised", reason: input.bind.status });
      }
    } else {
      for (const canary of SOURCE_DISCOVERY_CANARY) {
        for (const view of ["source_only", "mixed", "memory_only"] as const) {
          for (const sourceFirst of [true, false]) {
            await withPlantedSourceWorker(input.sourceCorpus, canary.distractor, async (planted) => {
              const publications = await publishCorePublicSources({ database: planted.database,
                workspaceId: WS, runId: RUN, now: NOW, bind: input.bind });
              if (publications.length === 0) throw new Error("admitted population has no published candidates");
              return { publications };
            }, async (planted, handler, receipts, client) => {
              planted.database.close();
              closeCachedDatabase(planted.filename);
              await awaitWorkerAfterMainSqliteClose(client);
              for (const enumeration of ["canonical", "associative"] as const) {
                for (const lookup of ["proposal", "source_text"] as const) {
                  const identity: CaseIdentity = { cell: sourceFirst ? "physical-source-first" : "physical-distractor-first",
                    group: canary.group, view, enumeration, lookup };
                  const offset = receipts.length;
                  try {
                    const request = publicSearchRequest(canary, lookup, view, enumeration);
                    const trace = await consumePublicSources({ handler,
                      context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" },
                      request, receipts });
                    const score = scoreConsumption(canary, planted.sourceId, trace, view, input.sourceCorpus);
                    const proposal_exposure = observePublishedProposalExposure({ trace,
                      firstCompleteStep: score.first_complete_step, request, bind: input.bind,
                      source: planted.source, workspaceId: WS, publications: planted.publications.map((row) => row.bound) });
                    rows.push({ ...identity, state: "completed", source_id: planted.sourceId, score, proposal_exposure });
                    traces.push({ provenance, request_key: input.bind.status === "complete" ? input.bind.cacheKey : null,
                      sqlite_reopened: true, publication_owner: "core-source-observation",
                      publications: planted.publications.map((row) => row.bound), trace: boundTrace(identity.cell, canary, view, enumeration,
                        lookup, trace, receipts.slice(offset)) });
                    completed.push(identity);
                  } catch (error) {
                    failed.push(identity);
                    rows.push({ ...identity, state: "failed", reason: String(error) });
                  }
                }
                if (view !== "memory_only") {
                  const identity: CaseIdentity = { cell: sourceFirst ? "physical-source-first" : "physical-distractor-first",
                    group: canary.group, view, enumeration, lookup: "proposal" };
                  const offset = receipts.length;
                  const request = { ...publicSearchRequest(canary, "proposal", view, enumeration),
                    interpretation_proposal: undefined };
                  try {
                    const trace = await consumePublicSources({ handler, request, receipts,
                      context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" } });
                    noHintControls.push({ ...identity, state: "completed", source_id: planted.sourceId,
                      score: scoreConsumption(canary, planted.sourceId, trace, view, input.sourceCorpus) });
                    noHintTraces.push({ provenance, comparison: "same-population-no-hint", sqlite_reopened: true,
                      request_key: input.bind.status === "complete" ? input.bind.cacheKey : null,
                      trace: boundTrace(identity.cell, canary, view, enumeration, "proposal", trace, receipts.slice(offset)) });
                  } catch (error) {
                    noHintControls.push({ ...identity, state: "failed", reason: String(error) });
                  }
                }
              }
            }, { sourceFirst, sourceId: input.bind.receive.located[0]?.artifact_key,
              ...(view === "source_only" ? {} : { memoryText: canary.original_query }) });
          }
        }
      }
    }
  } catch (error) {
    fileFailed = true;
    rows.push({ ...selected[0]!, state: "failed", reason: String(error) });
  } finally {
    persistRunEvidence({ rows, traces, selected, completed, failed, fileFailed,
      evidenceDirectory: input.evidenceDirectory, provenance,
      summary: { utility: aggregateAdmittedUtility(rows, selected.length, fileFailed, noHintControls),
        no_hint_controls: noHintControls,
        no_hint_traces: noHintTraces,
        request: input.bind.status === "complete" ? { cache_key: input.bind.cacheKey,
          raw_json: input.bind.rawJson, receive: input.bind.receive } : input.bind } });
  }
  return { provenance, protocol: PUBLIC_CONSUMPTION_PROTOCOL, selected, completed, failed, file_failed: fileFailed,
    rows, traces, no_hint_controls: noHintControls, no_hint_traces: noHintTraces,
    utility: aggregateAdmittedUtility(rows, selected.length, fileFailed, noHintControls) };
}

export function aggregateAdmittedUtility(rows: readonly MatrixRow[], expected: number, fileFailed: boolean,
  noHintControls: readonly MatrixRow[] = []) {
  const selected = admittedMatrixCases();
  const keys = rows.map(caseKey);
  const expectedKeys = new Set(selected.map(caseKey));
  const complete = !fileFailed && expected === selected.length && rows.length === expected &&
    new Set(keys).size === keys.length && keys.every((key) => expectedKeys.has(key)) &&
    missingCases(selected, rows.filter((row) => row.state === "completed")).length === 0 &&
    rows.every((row) => row.state === "completed");
  const selectedControls = selected.filter((row) => row.lookup === "proposal" && row.view !== "memory_only");
  const controlKeys = noHintControls.map(caseKey);
  const controlsComplete = noHintControls.length === selectedControls.length &&
    new Set(controlKeys).size === controlKeys.length &&
    missingCases(selectedControls, noHintControls.filter((row) => row.state === "completed")).length === 0 &&
    noHintControls.every((row) => row.state === "completed" && row.source_id !== undefined &&
      row.source_id === rows.find((main) => caseKey(main) === caseKey(row))?.source_id &&
      row.score?.first_complete_step != null && typeof row.score.primary_native_visits === "number" &&
      row.score.content.has_full_intended && row.score.content.has_all_required_phrases && !row.score.content.has_forbidden_distractor);
  const paired = rows.filter((row) => row.lookup === "proposal" && row.view !== "memory_only").map((proposal) => {
    const source = rows.find((row) => row.lookup === "source_text" && row.cell === proposal.cell &&
      row.group === proposal.group && row.view === proposal.view && row.enumeration === proposal.enumeration);
    const p = proposal.score?.primary_native_visits;
    const s = source?.score?.primary_native_visits;
    const control = noHintControls.find((row) => caseKey(row) === caseKey(proposal));
    const n = control?.score?.primary_native_visits;
    const witnessed = proposal.proposal_exposure?.status === "observed" && proposal.proposal_exposure.witnesses.length > 0;
    return { group: proposal.group, cell: proposal.cell, view: proposal.view, enumeration: proposal.enumeration,
      proposal: p ?? "not_exercised", source_text: s ?? "not_exercised",
      no_hint: n ?? "unavailable",
      complete: proposal.state === "completed" && source?.state === "completed" &&
        proposal.source_id !== undefined && source.source_id === proposal.source_id &&
        typeof p === "number" && typeof s === "number",
      strictly_improved: typeof p === "number" && typeof s === "number" ? p < s : null,
      proposal_exposure: proposal.proposal_exposure?.status ?? "unavailable",
      witnessed_improvement: typeof p === "number" && typeof s === "number" && p < s &&
        witnessed,
      net_hint_improvement: control?.state === "completed" && control.source_id === proposal.source_id &&
        typeof p === "number" && typeof s === "number" && typeof n === "number"
        ? p < s && p < n && witnessed : null };
  });
  const content = SOURCE_DISCOVERY_CANARY.map((canary: CanaryCase) => {
    const cells = rows.filter((row) => row.group === canary.group && row.view !== "memory_only");
    return { group: canary.group, complete: cells.length === 16 &&
      cells.every((row) => row.score?.first_complete_step != null && row.score.content.has_full_intended === true && row.score.content.has_all_required_phrases &&
        !row.score.content.has_forbidden_distractor) };
  });
  const comparisonComplete = complete && controlsComplete && paired.every((pair) => pair.complete) && content.every((item) => item.complete);
  const netHintImprovement = paired.some((pair) => pair.net_hint_improvement === true);
  return { evaluator_version: "published-hint-utility-v2", complete, pairs: paired, content_scope: content,
    acceptance_scope: "witnessed_improvement_over_text_and_same_population_no_hint",
    no_hint_controls_complete: controlsComplete,
    strict_improvement: paired.some((pair) => pair.strictly_improved === true),
    proposal_exposure_observed: paired.some((pair) => pair.proposal_exposure === "observed"),
    witnessed_paired_improvement: paired.some((pair) => pair.witnessed_improvement),
    net_hint_improvement: comparisonComplete ? netHintImprovement : null,
    causal_benefit: comparisonComplete && netHintImprovement ? "bounded_comparison_supported" : "not_established", agent_usage: "not_measured",
    accepted: comparisonComplete && netHintImprovement };
}
