import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { WS, RUN, NOW } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { SOURCE_DISCOVERY_CANARY, type CanaryCase } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { consumePublicSources } from "./source-discovery-public-consumer.js";
import { PUBLIC_CONSUMPTION_PROTOCOL, publicSearchRequest, scoreConsumption } from "./source-discovery-public-consumption.js";
import { boundTrace, caseKey, missingCases, persistRunEvidence, type CaseIdentity } from "./source-discovery-public-consumption-evidence.js";
import { withPlantedSourceWorker } from "./source-discovery-public-consumption-plant.js";
import { publishBoundPublicSources, type BoundPublicReceive } from "./source-discovery-admitted-public-publication.js";

type Score = ReturnType<typeof scoreConsumption>;
type MatrixRow = CaseIdentity & { readonly state: "completed" | "failed" | "not_exercised";
  readonly score?: Score; readonly reason?: string; readonly source_id?: string };

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
  const traces: unknown[] = [];
  const completed: CaseIdentity[] = [];
  const failed: CaseIdentity[] = [];
  let fileFailed = false;
  const provenance = input.bind.status === "complete" ? input.bind.provenance : "actual-model-not-exercised";
  try {
    if (input.bind.status !== "complete") {
      for (const identity of selected) rows.push({ ...identity, state: "not_exercised", reason: input.bind.status });
    } else {
      for (const canary of SOURCE_DISCOVERY_CANARY) {
        for (const view of ["source_only", "mixed", "memory_only"] as const) {
          for (const sourceFirst of [true, false]) {
            await withPlantedSourceWorker(input.sourceCorpus, canary.distractor, (planted) => {
              const publication = publishBoundPublicSources({ database: planted.database, source: planted.source,
                workspaceId: WS, runId: RUN, now: NOW, bind: input.bind });
              if (publication.gist_object_ids.length === 0) throw new Error("admitted population has no published candidates");
              return {};
            }, async (planted, handler, receipts, client) => {
              planted.database.close();
              closeCachedDatabase(planted.filename);
              await client.ready();
              for (const enumeration of ["canonical", "associative"] as const) {
                for (const lookup of ["proposal", "source_text"] as const) {
                  const identity: CaseIdentity = { cell: sourceFirst ? "physical-source-first" : "physical-distractor-first",
                    group: canary.group, view, enumeration, lookup };
                  const offset = receipts.length;
                  try {
                    const trace = await consumePublicSources({ handler,
                      context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" },
                      request: publicSearchRequest(canary, lookup, view, enumeration), receipts });
                    const score = scoreConsumption(canary, planted.sourceId, trace, view, input.sourceCorpus);
                    rows.push({ ...identity, state: "completed", source_id: planted.sourceId, score });
                    traces.push({ provenance, request_key: input.bind.status === "complete" ? input.bind.cacheKey : null,
                      sqlite_reopened: true, trace: boundTrace(identity.cell, canary, view, enumeration,
                        lookup, trace, receipts.slice(offset)) });
                    completed.push(identity);
                  } catch (error) {
                    failed.push(identity);
                    rows.push({ ...identity, state: "failed", reason: String(error) });
                  }
                }
              }
            }, { sourceFirst, ...(view === "source_only" ? {} : { memoryText: canary.original_query }) });
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
      summary: { utility: aggregateAdmittedUtility(rows, selected.length, fileFailed),
        request: input.bind.status === "complete" ? { cache_key: input.bind.cacheKey,
          raw_json: input.bind.rawJson, receive: input.bind.receive } : input.bind } });
  }
  return { provenance, protocol: PUBLIC_CONSUMPTION_PROTOCOL, selected, completed, failed, file_failed: fileFailed,
    rows, traces, utility: aggregateAdmittedUtility(rows, selected.length, fileFailed) };
}

export function aggregateAdmittedUtility(rows: readonly MatrixRow[], expected: number, fileFailed: boolean) {
  const selected = admittedMatrixCases();
  const keys = rows.map(caseKey);
  const expectedKeys = new Set(selected.map(caseKey));
  const complete = !fileFailed && expected === selected.length && rows.length === expected &&
    new Set(keys).size === keys.length && keys.every((key) => expectedKeys.has(key)) &&
    missingCases(selected, rows.filter((row) => row.state === "completed")).length === 0 &&
    rows.every((row) => row.state === "completed");
  const paired = rows.filter((row) => row.lookup === "proposal" && row.view !== "memory_only").map((proposal) => {
    const source = rows.find((row) => row.lookup === "source_text" && row.cell === proposal.cell &&
      row.group === proposal.group && row.view === proposal.view && row.enumeration === proposal.enumeration);
    const p = proposal.score?.primary_native_visits;
    const s = source?.score?.primary_native_visits;
    return { group: proposal.group, cell: proposal.cell, view: proposal.view, enumeration: proposal.enumeration,
      proposal: p ?? "not_exercised", source_text: s ?? "not_exercised",
      complete: proposal.state === "completed" && source?.state === "completed" &&
        typeof p === "number" && typeof s === "number",
      strictly_improved: typeof p === "number" && typeof s === "number" ? p < s : null };
  });
  const content = SOURCE_DISCOVERY_CANARY.map((canary: CanaryCase) => {
    const cells = rows.filter((row) => row.group === canary.group && row.view !== "memory_only");
    return { group: canary.group, complete: cells.length === 16 &&
      cells.every((row) => row.score?.first_complete_step != null && row.score.content.has_full_intended === true && row.score.content.has_all_required_phrases &&
        !row.score.content.has_forbidden_distractor) };
  });
  return { complete, pairs: paired, content_scope: content,
    strict_improvement: paired.some((pair) => pair.strictly_improved === true),
    accepted: complete && paired.every((pair) => pair.complete) && content.every((item) => item.complete) && paired.some((pair) => pair.strictly_improved === true) };
}
