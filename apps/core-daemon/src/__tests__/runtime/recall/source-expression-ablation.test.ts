import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { expect, it } from "vitest";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { WS, RUN, NOW } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { SOURCE_DISCOVERY_CANARY } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { bindReceivedSourceInterpretationPayload } from "./source-discovery-admitted-public-publication.js";
import { publishCorePublicSources } from "./source-discovery-native-publication.js";
import { awaitWorkerAfterMainSqliteClose, withPlantedSourceWorker } from "./source-discovery-public-consumption-plant.js";
import { observePlantedDiscovery, publicSearchRequest, scoreConsumption } from "./source-discovery-public-consumption.js";
import { consumePublicSources } from "./source-discovery-public-consumer.js";
import { runAdmittedPublicMatrix } from "./source-discovery-admitted-matrix.js";
import { replayRetainedAdmission } from "../../../../../../apps/bench-runner/src/runs/extraction/enrichment-acceptance/retained-admission-replay.js";
import { resultCandidateIdentity } from "./source-discovery-public-consumption-evidence.js";

// Opt-in provider-free diagnostic. Packets are authored populations, never repaired admission receipts.
const configuration = process.env.ALAYA_RETAINED_ADMISSION_CONFIG;
const required = new Set([2, 4, 8]);
const phrase = (text: string) => ({ text });
const role = (name: string, text: string) => ({ role: name, phrase: phrase(text) });
// Explicit source-faithful controls are authored here independently of the frozen query object.
const alignedRelations = new Map([
  [2, [{ predicate: phrase("strives"), arguments: [role("aim", "definitive cloud platform")],
    qualifiers: [role("audience", "gamers, creatives, and businesses"),
      role("scope", "potential to bring technological freedom to all")] }]],
  [4, [{ predicate: phrase("access"), arguments: [role("capability", "full PC"),
    role("devices", "all the devices you own")], qualifiers: [role("temporal", "instantly")] }]],
  [8, [{ predicate: phrase("released"), arguments: [role("theme", "original product"),
    role("promise", "promise of allowing all individuals to enjoy the power of a high-end PC from the cloud")],
    qualifiers: [] }]]
]);

it.skipIf(configuration === undefined)("measures isolated expression populations with fixed source, query, budget and public worker", async () => {
  const input = JSON.parse(readFileSync(configuration!, "utf8")) as Parameters<typeof replayRetainedAdmission>[0];
  const directory = process.env.ALAYA_ADMISSION_EVIDENCE_DIRECTORY;
  if (directory === undefined) throw new Error("ablation evidence directory is required");
  const outputRelative = relative(dirname(realpathSync(input.cacheRoot)), realpathSync(directory));
  if (outputRelative === "" || (!isAbsolute(outputRelative) && outputRelative !== ".." && !outputRelative.startsWith(`..${sep}`))) {
    throw new Error("synthetic diagnostics must stay outside the retained paid root");
  }
  const outputPath = join(directory, `source-expression-ablation-${Date.now()}.json`);
  const retained = replayRetainedAdmission(input);
  for (const [index, id] of [2, 4, 8].entries()) {
    expect(retained.request.source_assertions.find((row) => row.assertion_id === id)?.text)
      .toBe(SOURCE_DISCOVERY_CANARY[index]!.intended);
  }
  const original = JSON.parse(retained.rawJson) as { interpretations: { assertion_id: number; relations: unknown[] }[] };
  const packets = Object.fromEntries((["located-model-subset", "source-faithful-aligned"] as const).map((arm) => [arm,
    JSON.stringify({ interpretations: original.interpretations.map((row) => ({
      assertion_id: row.assertion_id,
      relations: required.has(row.assertion_id)
        ? arm === "located-model-subset" ? row.relations : alignedRelations.get(row.assertion_id)!
        : []
    })) })]));
  const rows: unknown[] = [];
  let rawMatrix: unknown;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("network forbidden in expression ablation"); };
  try {
    for (const arm of ["source-only", "located-model-subset", "source-faithful-aligned"] as const) {
      const bind = arm === "source-only" ? undefined : bindReceivedSourceInterpretationPayload({
        rawJson: packets[arm]!, sourceCorpus: retained.sourceCorpus,
        artifactKey: "synthetic-diagnostic-source", request: retained.request
      });
      if (bind !== undefined) expect(bind.status).toBe("complete");
      for (const canary of SOURCE_DISCOVERY_CANARY) {
        for (const sourceFirst of [true, false]) {
          await withPlantedSourceWorker(retained.sourceCorpus, canary.distractor, async (planted) => {
            const publication = bind === undefined ? undefined : await publishCorePublicSources({
              database: planted.database, workspaceId: WS, runId: RUN, now: NOW, bind
            });
            if (publication !== undefined) expect(publication).toHaveLength(3);
            return { native: Object.fromEntries((["canonical", "associative"] as const).flatMap((enumeration) =>
              (["proposal", "source_text"] as const).map((lookup) => [`${enumeration}-${lookup}`,
                observePlantedDiscovery(planted.database, WS, canary, lookup, "source_only", enumeration)]))) };
          }, async (planted, handler, receipts, client) => {
            planted.database.close();
            closeCachedDatabase(planted.filename);
            await awaitWorkerAfterMainSqliteClose(client);
            for (const enumeration of ["canonical", "associative"] as const) {
              for (const lookup of ["proposal", "source_text", "no-hint"] as const) {
                const offset = receipts.length;
                const compiled = publicSearchRequest(canary, lookup === "no-hint" ? "proposal" : lookup, "source_only", enumeration);
                const request = lookup === "no-hint" ? { ...compiled, interpretation_proposal: undefined } : compiled;
                const publicReasons: unknown[] = [];
                const trace = await consumePublicSources({ handler: async (request, context) => {
                  const response = await handler(request, context);
                  publicReasons.push(response.results.map((row) => ({ target: row.target,
                    source_lookup_reasons: row.source_lookup_reasons ?? [] })));
                  return response;
                },
                  context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" }, request, receipts });
                const score = scoreConsumption(canary, planted.sourceId, trace, "source_only", retained.sourceCorpus);
                const first = score.first_complete_step === null ? null : trace.steps[score.first_complete_step]!;
                rows.push({ arm, provenance: "synthetic-diagnostic", group: canary.group, sourceFirst, enumeration,
                  lookup, sqlite_reopened: true, publication_owner: "core-source-observation", request, source_id: planted.sourceId, distractor_id: planted.distractorId,
                  native: planted.native[`${enumeration}-${lookup}`], score,
                  wrong_contexts_seen_by_first_complete: first === null ? null
                    : Object.keys(first.source_bodies).filter((id) => id !== planted.sourceId).length,
                  publicReasons, trace, receipts: receipts.slice(offset) });
                expect(score.content.has_full_intended).toBe(true);
                expect(score.content.has_all_required_phrases).toBe(true);
                expect(score.content.has_forbidden_distractor).toBe(false);
                expect(score.first_complete_step).not.toBeNull();
              }
            }
          }, { sourceFirst, sourceId: "synthetic-diagnostic-source" });
        }
      }
    }
    expect(rows).toHaveLength(108);
    rawMatrix = await runAdmittedPublicMatrix({ sourceCorpus: retained.sourceCorpus,
      bind: bindReceivedSourceInterpretationPayload({ rawJson: packets["located-model-subset"]!,
        sourceCorpus: retained.sourceCorpus, artifactKey: "synthetic-raw-matrix", request: retained.request }) });
    expect(fetchCalls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    writeFileSync(outputPath, JSON.stringify({ configuration, provenance: "synthetic-diagnostic-only",
      result_identity: resultCandidateIdentity(), retained_input_identity: retained.input_identity,
      design: "Three fixed-source populations; selected raw relations copied verbatim into authored packet; other rows explicitly omitted only in synthetic arm; all historical admission unchanged",
      packets, fetchCalls, rows, rawMatrix }, null, 2), { flag: "wx" });
  }
}, 120_000);
