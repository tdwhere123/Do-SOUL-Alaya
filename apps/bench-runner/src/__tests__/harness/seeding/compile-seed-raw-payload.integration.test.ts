import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary({ ownedTemporaryFixtures: true });
});
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceStatementSignalSchema } from "@do-soul/alaya-protocol";
import { OfficialApiGardenProvider, sourceStatementSessionInput } from "@do-soul/alaya-soul";
import { initDatabase, SqliteMemoryEntryRepo, SqliteSignalRepo } from "@do-soul/alaya-storage";
import { startBenchDaemon, type BenchDaemonHandle, type BenchSignalSeedInput } from "../../../harness/daemon.js";

let daemon: BenchDaemonHandle | undefined, root: string | undefined;
afterEach(async () => {
  await daemon?.shutdown(); daemon = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined;
});
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });
async function start() {
  root = await mkdtemp(join(tmpdir(), "bound-compile-publication-"));
  daemon = await startBenchDaemon({ dataDirRoot: root, workspaceId: "compile-workspace", runId: "compile-run" });
  return daemon;
}

const unboundInput = (): BenchSignalSeedInput => ({ signalKind: "potential_claim", objectKind: "fact",
  confidence: 0.9, distilledFact: "A proposed fact.", turnContent: "A proposed fact.",
  evidenceRef: "unbound-compile", turnSeedIndex: 0, extractionProvider: "official_api_compile" });

describe("bound compile publication", () => {
  it("refuses unbound passive payloads and synthetic fallback flags before any durable signal or memory write", async () => {
    const handle = await start();
    const inputs: BenchSignalSeedInput[] = [unboundInput(),
      { ...unboundInput(), productionRawPayload: { source_interpretation: { retained: true } } },
      { ...unboundInput(), signalKind: "potential_evidence_anchor", objectKind: "source_turn", confidence: 1,
        evidenceFallbackReason: "empty_extraction" }];
    const result = await handle.proposeMemoriesFromCompileSignals(inputs);
    expect(result).toMatchObject({ seeds: [], createdEvidence: false });
    expect(result.dropped).toHaveLength(inputs.length);
    expect(result.dropped.every(row => row.reason === "materialization_drop" && row.detail.includes("bound source statement"))).toBe(true);
    const database = initDatabase({ filename: join(handle.dataDir, "alaya.db") });
    for (const table of ["signals", "memory_entries", "evidence_capsules", "source_records"]) {
      expect(database.connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  }, 60_000);

  it("publishes a bounded statement without clipping its long admitted host message into a different source", async () => {
    const handle = await start();
    const text = ("The source turn records one durable fact. " + "Background context. ".repeat(900)).slice(0, 15_000);
    const messages = [{ message_id: "recorded-user", role: "user" as const, content: text }];
    const source = sourceStatementSessionInput(messages);
    const admitted = await handle.importSourceRecord({ source_id: "long-recorded-turn", source_version: "1",
      content_bytes: source.rendered.content, recorded_at: "2026-09-14T00:00:00.000Z", event_time: null,
      valid_from: null, valid_to: null, scope_class: "project", spans: [],
      host_occurrences: source.rendered.occurrences.map(occurrence => ({ occurrence_id: messages[0]!.message_id,
        utf8_span: occurrence.utf8_span, role: "user", channel: null, author_ref: null, container_ref: null,
        upstream_message_ref: null, upstream_position: null, completeness: "complete", fidelity: occurrence.fidelity }))
    }, request => ({ namespace: "recorded-conversation", workspace_id: request.workspace_id,
      producer: "recorded-host", basis: "pinned_dataset" }));
    const statement = { text: "The source turn records one durable fact.", relation: "recorded fact" };
    const provider = new OfficialApiGardenProvider({ apiKey: "recorded-key", extractor: {
      extract: async ({ userPrompt }) => {
        expect(JSON.parse(userPrompt).messages[0]).toMatchObject({ text, role: "user", recorded_at: null });
        return { rawJson: JSON.stringify({ messages: [{ message_id: "recorded-user", statements: [statement] }] }) };
      }
    } });
    const [candidate] = await provider.compile(text, { workspace_id: handle.workspaceId, run_id: handle.runId,
      surface_id: null, turn_messages: messages, artifact_key: admitted.record.source_id, source_root_id: admitted.record.identity });
    const signal = SourceStatementSignalSchema.parse(candidate);
    const receive = vi.spyOn(handle.runtime.services.signalService, "receiveSignal");
    const result = await handle.proposeMemoriesFromCompileSignals([{ signalKind: signal!.signal_kind,
      distilledFact: statement.text, turnContent: text, turnMessages: messages, evidenceRef: "long-recorded-statement",
      productionSignal: signal, productionRawPayload: signal.raw_payload, turnSeedIndex: 0,
      extractionProvider: "official_api_compile" }]);
    expect(result.dropped, JSON.stringify((await receive.mock.results[0]!.value).materialization)).toEqual([]);
    expect(result.seeds).toHaveLength(1);
    const seed = result.seeds[0]!;
    if (seed.kind !== "memory_entry") throw new Error("expected statement memory");
    const database = initDatabase({ filename: join(handle.dataDir, "alaya.db") });
    expect(await new SqliteSignalRepo(database).getById(seed.signalId)).toMatchObject({
      source: "garden_compile", interpretation_contract: "source-statements-v1", raw_payload: { source_statement: {
        source_root_id: admitted.record.identity, message: { text, recorded_at: null }, statement } } });
    expect(await new SqliteMemoryEntryRepo(database).findById(seed.memoryId)).toMatchObject({
      dimension: "observation", confidence: null, content: statement.text });
    expect(database.connection.prepare("SELECT count(*) AS count FROM source_records").get()).toEqual({ count: 1 });
    expect(database.connection.prepare("SELECT source_body FROM source_records WHERE record_id=?")
      .get(admitted.record.identity)).toEqual({ source_body: source.rendered.content });
    expect(database.connection.prepare("SELECT count(*) AS count FROM source_statement_artifacts").get()).toEqual({ count: 1 });
  }, 60_000);

  it("keeps explicitly authored model-tool candidate seeding separate from passive compilation", async () => {
    const handle = await start();
    const seed = await handle.proposeMemoryFromSignal({ signalKind: "potential_preference", objectKind: "fact",
      confidence: 0.9, distilledFact: "An explicitly supplied candidate.", turnContent: "An explicitly supplied candidate.",
      evidenceRef: "explicit-candidate", turnSeedIndex: 1, extractionProvider: "no_credentials_fallback" });
    const database = initDatabase({ filename: join(handle.dataDir, "alaya.db") });
    expect(await new SqliteSignalRepo(database).getById(seed.signalId)).toMatchObject({ source: "model_tool" });
    expect(await new SqliteMemoryEntryRepo(database).findById(seed.memoryId)).not.toBeNull();
  }, 60_000);
});
