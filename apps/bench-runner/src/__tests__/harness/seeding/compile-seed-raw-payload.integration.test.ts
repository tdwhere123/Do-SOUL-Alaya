import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SignalEventType } from "@do-soul/alaya-protocol";
import { OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteSignalRepo
} from "@do-soul/alaya-storage";
import { startBenchDaemon, type BenchDaemonHandle } from "../../../harness/daemon.js";
import { extractSeedInputs } from "../../../longmemeval/compile-seed/compile-seed-extract.js";
import type { CompileSeedExtractionStats } from "../../../longmemeval/compile-seed.js";
import { withOpenSemanticFactorGraph } from
  "../../longmemeval/compile-seed/compile-seed-fixture.js";

function longOfficialCompileInput(turnContent: string) {
  return {
    signalKind: "potential_claim" as const,
    objectKind: "fact" as const,
    confidence: 0.9,
    distilledFact: "The source turn records one durable fact.",
    turnContent,
    evidenceRef: "compile-seed-payload-evidence",
    turnSeedIndex: 31,
    extractionProvider: "official_api_compile" as const,
    productionRawPayload: {
      matched_text: "one durable fact",
      distilled_fact: "The source turn records one durable fact.",
      full_turn_content: turnContent
    }
  };
}

describe("compile-seed raw payload projection", () => {
  let daemon: BenchDaemonHandle | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await daemon?.shutdown().catch(() => undefined);
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("materializes a long official compile turn with a verifiable bounded projection", async () => {
    const turnContent = (
      "The source turn records one durable fact. " + "Long source turn. ".repeat(900)
    ).slice(0, 15_000);
    const digest = `sha256:${createHash("sha256").update(turnContent, "utf8").digest("hex")}`;
    root = await mkdtemp(join(tmpdir(), "compile-seed-payload-"));
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "compile-seed-payload-workspace",
      runId: "compile-seed-payload-run"
    });

    const { seeds, dropped } = await daemon.proposeMemoriesFromCompileSignals([
      longOfficialCompileInput(turnContent)
    ]);

    expect(dropped).toEqual([]);
    expect(seeds).toHaveLength(1);
    const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
    const signal = await new SqliteSignalRepo(db).getById(seeds[0]!.signalId);
    expect(signal?.raw_payload).not.toHaveProperty("bench_full_turn_content");
    expect(signal?.raw_payload).toMatchObject({
      bench_seed: true,
      bench_turn_seed_index: 31,
      bench_full_turn_tokens: Math.ceil(turnContent.length / 4),
      bench_full_turn_char_count: turnContent.length,
      bench_full_turn_sha256: digest
    });

    const events = await new SqliteEventLogRepo(db).queryByRun(daemon.runId);
    const emitted = events.find(
      (event) => event.event_type === SignalEventType.SOUL_SIGNAL_EMITTED
    );
    expect(emitted?.payload_json).toMatchObject({
      raw_payload: {
        bench_summary_seeded: true,
        bench_summary_turn_seed_index: 31,
        bench_full_turn_tokens: Math.ceil(turnContent.length / 4),
        bench_full_turn_char_count: turnContent.length,
        bench_full_turn_sha256: digest
      }
    });
  }, 60_000);

  it("projects a near-cap provider payload without losing its semantic fields or identity", async () => {
    const turnContent = (
      "The source turn records one durable fact. " + "context ".repeat(256)
    );
    const productionRawPayload = {
      matched_text: "The source turn records one durable fact.",
      distilled_fact: "The source turn records one durable fact.",
      full_turn_content: turnContent,
      canonical_entities: ["source turn"],
      provider_diagnostics: "x".repeat(16_000)
    };
    root = await mkdtemp(join(tmpdir(), "compile-seed-near-cap-"));
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "compile-seed-near-cap-workspace",
      runId: "compile-seed-near-cap-run"
    });

    const { seeds, dropped } = await daemon.proposeMemoriesFromCompileSignals([
      {
        signalKind: "potential_claim",
        objectKind: "fact",
        confidence: 0.9,
        distilledFact: "The source turn records one durable fact.",
        turnContent,
        evidenceRef: "compile-seed-near-cap-evidence",
        turnSeedIndex: 32,
        extractionProvider: "official_api_compile",
        productionRawPayload
      }
    ]);

    expect(dropped).toEqual([]);
    const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
    const signal = await new SqliteSignalRepo(db).getById(seeds[0]!.signalId);
    expect(JSON.stringify(signal?.raw_payload).length).toBeLessThanOrEqual(16_384);
    expect(signal?.raw_payload).toMatchObject({
      matched_text: productionRawPayload.distilled_fact,
      distilled_fact: productionRawPayload.distilled_fact,
      bench_source_raw_payload_projected: true
    });
    expect(signal?.raw_payload.canonical_entities).toEqual(["source turn"]);
    expect(signal?.raw_payload.bench_source_raw_payload_key_count).toBeGreaterThan(
      Object.keys(productionRawPayload).length
    );
    expect(signal?.raw_payload.bench_source_raw_payload_char_count).toBeGreaterThan(14_000);
    expect(signal?.raw_payload).not.toHaveProperty("provider_diagnostics");
    expect(signal?.raw_payload.bench_source_raw_payload_sha256).toMatch(
      /^sha256:[0-9a-f]{64}$/u
    );
  }, 60_000);

  it("does not truncate a near-cap preference proposal into a grounded prefix", async () => {
    const proposedObject = "x".repeat(600);
    const source = `I prefer ${proposedObject}.`;
    const turnMessages = [{
      message_id: "u-long-preference",
      role: "user" as const,
      content: source
    }];
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: {
        extract: async () => ({
          rawJson: JSON.stringify({
            signals: [withOpenSemanticFactorGraph({
              signal_kind: "potential_preference",
              object_kind: "preference",
              confidence: 0.9,
              matched_text: source,
              source_locator: {
                contract_version: 2,
                kind: "assertion_catalog",
                assertion_id: 1
              },
              preference_profile: {
                projection_schema_version: 1,
                preference_subject: "I",
                preference_predicate: "prefer",
                preference_object: proposedObject,
                preference_polarity: "positive"
              },
              provider_diagnostics: "x".repeat(15_000)
            })]
          })
        })
      },
      generateSignalId: () => "signal-long-preference"
    });
    const [draft] = await extractSeedInputs({
      provider,
      stats: extractionStats(),
      turnContent: source,
      seedIndex: 36,
      context: {
        workspace_id: "compile-seed-preference-cap-workspace",
        run_id: "compile-seed-preference-cap-run",
        surface_id: null,
        turn_messages: turnMessages
      }
    });
    expect(draft).toBeDefined();
    expect.soft(draft?.productionRawPayload?.source_grounding).toMatchObject({
      status: "grounded",
      source_assertion: source,
      proposed_preference_profile: {
        preference_object: proposedObject
      }
    });
    expect.soft(draft?.productionRawPayload?.preference_profile).toMatchObject({
      preference_object: proposedObject
    });
    root = await mkdtemp(join(tmpdir(), "compile-seed-preference-cap-"));
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "compile-seed-preference-cap-workspace",
      runId: "compile-seed-preference-cap-run"
    });

    const { seeds, dropped } = await daemon.proposeMemoriesFromCompileSignals([{
      ...draft!,
      evidenceRef: "compile-seed-preference-cap-evidence",
      productionRawPayload: {
        ...draft!.productionRawPayload,
        projection_pressure: "x".repeat(15_000)
      }
    }]);

    expect(dropped).toEqual([]);
    expect(seeds).toHaveLength(1);
    const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
    const signal = await new SqliteSignalRepo(db).getById(seeds[0]!.signalId);
    expect(signal?.raw_payload.bench_source_raw_payload_projected).toBe(true);
    expect(signal?.raw_payload.preference_profile).toMatchObject({
      preference_object: proposedObject
    });
    expect(signal?.raw_payload.source_grounding).toMatchObject({
      proposed_preference_profile: {
        preference_object: proposedObject
      }
    });
    expect(signal?.raw_payload.source_locator).toEqual({
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: 1
    });
    expect(signal?.raw_payload.verified_user_assertion_source_hash).toMatch(
      /^sha256:garden-verified-user-assertion-v1:[0-9a-f]{64}$/u
    );
    expect(signal?.raw_payload.semantic_factor_graph).toEqual(
      draft?.productionRawPayload?.semantic_factor_graph
    );
  }, 60_000);

  it("bounds structured keys when the first projection still overflows after grounding", async () => {
    const oversizedEntity = "entity".repeat(2_600);
    root = await mkdtemp(join(tmpdir(), "compile-seed-structured-cap-"));
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "compile-seed-structured-cap-workspace",
      runId: "compile-seed-structured-cap-run"
    });

    const { seeds, dropped } = await daemon.proposeMemoriesFromCompileSignals([
      {
        ...longOfficialCompileInput("The source turn records one durable fact."),
        evidenceRef: "compile-seed-structured-cap-evidence",
        turnSeedIndex: 33,
        productionRawPayload: {
          matched_text: "one durable fact",
          distilled_fact: "The source turn records one durable fact.",
          canonical_entities: [oversizedEntity]
        }
      }
    ]);

    expect(dropped).toEqual([]);
    expect(seeds).toHaveLength(1);
    const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
    const signal = await new SqliteSignalRepo(db).getById(seeds[0]!.signalId);
    expect(JSON.stringify(signal?.raw_payload).length).toBeLessThanOrEqual(16_384);
    expect(signal?.raw_payload).not.toHaveProperty("canonical_entities");
    expect(signal?.raw_payload.source_grounding).toMatchObject({
      reasons: expect.arrayContaining(["unverified_canonical_entities_removed"])
    });
    expect(signal?.raw_payload.bench_source_raw_payload_projected).toBe(true);
  }, 60_000);

  it("revalidates cached grounding and removes unverified structured projections", async () => {
    root = await mkdtemp(join(tmpdir(), "compile-seed-reground-cache-"));
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "compile-seed-reground-workspace",
      runId: "compile-seed-reground-run"
    });
    const { seeds, dropped } = await daemon.proposeMemoriesFromCompileSignals([{
      signalKind: "potential_claim",
      objectKind: "fact",
      confidence: 0.9,
      distilledFact: "Alice lives in Berlin.",
      turnContent: "I moved to Berlin.",
      evidenceRef: "compile-seed-reground-evidence",
      turnSeedIndex: 34,
      extractionProvider: "official_api_compile",
      productionRawPayload: {
        matched_text: "I moved to Berlin.",
        distilled_fact: "Alice lives in Berlin.",
        full_turn_content: "I moved to Berlin.",
        canonical_entities: ["alice", "berlin", "operator"],
        preference_profile: { preference_object: "Paris" },
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: "I moved to Berlin.",
          proposed_matched_text: "I moved to Berlin.",
          reasons: []
        }
      }
    }]);
    expect(dropped).toEqual([]);
    const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
    const signal = await new SqliteSignalRepo(db).getById(seeds[0]!.signalId);
    expect(signal?.raw_payload.canonical_entities).toEqual(["berlin", "operator"]);
    expect(signal?.raw_payload).not.toHaveProperty("preference_profile");
    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "grounded",
      proposed_canonical_entities: ["alice", "berlin", "operator"],
      proposed_preference_profile: { preference_object: "Paris" }
    });
  }, 60_000);

  it("rejects a cached grounding assertion that is absent from the current turn", async () => {
    root = await mkdtemp(join(tmpdir(), "compile-seed-reground-mismatch-"));
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "compile-seed-mismatch-workspace",
      runId: "compile-seed-mismatch-run"
    });
    const { seeds, dropped } = await daemon.proposeMemoriesFromCompileSignals([{
      signalKind: "potential_claim",
      objectKind: "fact",
      confidence: 0.9,
      distilledFact: "I moved to Berlin.",
      turnContent: "I stayed in Paris.",
      evidenceRef: "compile-seed-mismatch-evidence",
      turnSeedIndex: 35,
      extractionProvider: "official_api_compile",
      productionRawPayload: {
        matched_text: "I moved to Berlin.",
        distilled_fact: "I moved to Berlin.",
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: "I moved to Berlin.",
          proposed_matched_text: "I moved to Berlin.",
          reasons: []
        }
      }
    }]);
    expect(seeds).toEqual([]);
    expect(dropped).toEqual([
      expect.objectContaining({ reason: "candidate_absent" })
    ]);
  }, 60_000);
});

function extractionStats(): CompileSeedExtractionStats {
  return {
    path: "official_api_compile",
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    liveExtractionFailures: 0,
    cachedExtractionFailures: 0,
    factsProduced: 0,
    signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 },
    parseDropped: 0,
    compileOverflowDropped: 0,
    lastTurnRawSignalCount: 1,
    lastTurnDraftCount: 1,
    lastExtractionSource: null,
    lastRawJsonSha256: null
  };
}
