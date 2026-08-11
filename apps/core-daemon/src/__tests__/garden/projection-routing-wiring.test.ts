import { describe, expect, it } from "vitest";
import {
  SignalEventType,
  SignalState,
  SoulSignalMaterializedPayloadSchema,
  type CandidateMemorySignal,
  type EventLogEntry,
} from "@do-soul/alaya-protocol";
import {
  EvidenceService,
  MemoryService,
  RecallService,
  type RecallServiceDependencies
} from "@do-soul/alaya-core";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  OfficialApiGardenProvider,
  verifyOfficialApiSourceLocatorBinding
} from "@do-soul/alaya-soul";
import {
  SqliteEnrichPendingRepo,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-soul/alaya-storage";
import {
  createPreferenceProjectionSignal,
  recallSurface,
  seedHigherRankedFillers,
  seedWorkspaceRun
} from "./projection-routing-wiring-fixture.js";

const MEMORY_ID = "44444444-4444-4444-8444-444444444444";
const EVIDENCE_ID = "55555555-5555-4555-8555-555555555555";

// With projectionRoutingEnabled on, a preference_profile workflow_preference lifts to memory_entry_only; off stays signal_only.
describe("projection routing daemon wiring", () => {
  it("lifts a workflow_preference projection signal to a memory_entry when projections are on", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const harness = await createHarness(database, { projectionRoutingEnabled: true });

      const result = await harness.router.materializeSignal(createPreferenceProjectionSignal());

      expect(result.success).toBe(true);
      expect(result.route_target).toBe("memory_entry_only");
      const memories = await harness.memoryRepo.findByWorkspaceId("workspace-1");
      expect(memories).toHaveLength(1);
      const memory = memories[0]!;
      expect(memory.preference_subject).toBe("operator");
      expect(memory.preference_predicate).toBe("prefers");
      expect(memory.preference_object).toBe("dark mode");
      expect(memory.preference_polarity).toBe("positive");
      expect(memory.projection_schema_version).toBe(1);
    } finally {
      database.close();
    }
  });

  it("leaves a workflow_preference projection signal as signal_only when projections are off", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const harness = await createHarness(database, { projectionRoutingEnabled: false });

      const result = await harness.router.materializeSignal(createPreferenceProjectionSignal());

      expect(result.success).toBe(true);
      expect(result.route_target).toBe("signal_only");
      await expect(harness.memoryRepo.findByWorkspaceId("workspace-1")).resolves.toHaveLength(0);
      await expect(harness.evidenceRepo.findByWorkspaceId("workspace-1")).resolves.toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      shape: "place",
      source: [
        "I wanted to create more space in my apartment.",
        "The new bookshelf is from IKEA, and I'm really happy with it."
      ].join(" "),
      assertionNeedle: "bookshelf is from IKEA",
      query: "Where did I buy my new bookshelf from?"
    },
    {
      shape: "duration",
      source: "I waited over a year for the decision on my asylum application.",
      assertionNeedle: "waited over a year",
      query: "How long did I wait for the decision on my asylum application?"
    }
  ])("carries an official grounded User $shape assertion through SQLite into recall authority", async (
    scenario
  ) => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const harness = await createHarness(database, { projectionRoutingEnabled: true });
      const signal = await compileRecallSignal(scenario.source, scenario.assertionNeedle);
      const materialized = await materializeRecallSignal(harness, signal);

      expect(materialized.success).toBe(true);
      const [memory] = await harness.memoryRepo.findByWorkspaceId("workspace-1");
      const [evidence] = await harness.evidenceRepo.findByWorkspaceId("workspace-1");
      expect(memory?.evidence_refs).toEqual([evidence?.object_id]);
      expect(evidence).toMatchObject({
        created_by: "garden_compile",
        evidence_kind: "conversation_excerpt",
        evidence_health_state: "verified"
      });
      await expect(harness.evidenceRepo.findRecallQualifiedByIds(
        "workspace-1", [{ object_id: evidence!.object_id }]
      )).resolves.toMatchObject([{ capsule: { object_id: evidence!.object_id } }]);

      const recallService = createRecallService(harness.memoryRepo, harness.evidenceRepo);
      const result = await recallService.recall({
        taskSurface: recallSurface(scenario.query),
        workspaceId: "workspace-1",
        runId: "run-1",
        strategy: "build",
        diagnosticCapture: "answer_features"
      });
      const diagnostic = result.diagnostics?.candidates.find(
        (row) => row.object_id === memory?.object_id
      );

      expect(result.candidates.map((row) => row.object_id)).toContain(memory?.object_id);
      expect(diagnostic).toMatchObject({
        final_rank: 1,
        answer_features: {
          answer_support: {
            shape: scenario.shape,
            authority: {
              provenance_status: "verified_user_assertion",
              behavior_eligible: true,
              evidence_ref: evidence?.object_id
            }
          }
        }
      });
    } finally {
      database.close();
    }
  });

  it("does not use a verified assertion owner's gist as an unverified search projection", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const harness = await createHarness(database, { projectionRoutingEnabled: true });
      const source = [
        "My asylum application took a long time to get approved.",
        "Over a year of uncertainty was really tough."
      ].join(" ");
      const signal = await compileRecallSignal(source, "Over a year");
      const materialized = await materializeRecallSignal(harness, signal);

      expect(materialized.success).toBe(true);
      const [memory] = await harness.memoryRepo.findByWorkspaceId("workspace-1");
      const [evidence] = await harness.evidenceRepo.findByWorkspaceId("workspace-1");
      expect(evidence).toMatchObject({
        gist: `User: ${source}`,
        excerpt: "Over a year of uncertainty was really tough.",
        source_hash: expect.stringMatching(
          /^sha256:garden-verified-user-assertion-v2:[a-f0-9]{64}$/u
        )
      });

      const result = await createRecallService(
        harness.memoryRepo,
        harness.evidenceRepo
      ).recall({
        taskSurface: recallSurface("What happened with my asylum application?"),
        workspaceId: "workspace-1",
        runId: "run-1",
        strategy: "build",
        diagnosticCapture: "answer_features"
      });

      expect(result.candidates.map((row) => row.object_id))
        .not.toContain(memory?.object_id);
    } finally {
      database.close();
    }
  });

  it("moves a persisted verified answer from public rank six into slot five", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const harness = await createHarness(database, { projectionRoutingEnabled: true });
      const source = [
        "I wanted to create more space in my apartment.",
        "The new bookshelf is from IKEA, and I'm really happy with it."
      ].join(" ");
      const signal = await compileRecallSignal(source, "bookshelf is from IKEA");
      const materialized = await materializeRecallSignal(harness, signal);

      expect(materialized.success).toBe(true);
      const [answer] = await harness.memoryRepo.findByWorkspaceId("workspace-1");
      const [evidence] = await harness.evidenceRepo.findByWorkspaceId("workspace-1");
      if (answer === undefined || evidence === undefined) {
        throw new Error("persisted verified answer missing");
      }
      await seedHigherRankedFillers(harness.memoryRepo, answer);
      const result = await createRecallService(
        harness.memoryRepo,
        harness.evidenceRepo
      ).recall({
        taskSurface: recallSurface("Where did I buy my new bookshelf from?"),
        workspaceId: "workspace-1",
        runId: "run-1",
        strategy: "build",
        diagnosticCapture: "answer_features"
      });
      const diagnostic = result.diagnostics?.candidates.find(
        (row) => row.object_id === answer.object_id
      );
      const publicHead = [...(result.diagnostics?.candidates ?? [])]
        .filter((row) => row.final_rank !== null)
        .sort((left, right) => left.fused_rank - right.fused_rank)
        .slice(0, 4)
        .map((row) => row.object_id);

      expect(diagnostic).toMatchObject({
        fused_rank: 6,
        final_rank: 5,
        answer_features: {
          answer_support: {
            authority: {
              behavior_eligible: true,
              evidence_ref: evidence.object_id
            }
          }
        }
      });
      expect(result.candidates.slice(0, 4).map((row) => row.object_id)).toEqual(publicHead);
      expect(result.candidates[4]?.object_id).toBe(answer.object_id);
    } finally {
      database.close();
    }
  });
});

async function createHarness(
  database: ReturnType<typeof initDatabase>,
  options: { readonly projectionRoutingEnabled: boolean }
) {
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const evidenceRepo = new SqliteEvidenceCapsuleRepo(
    database,
    verifyOfficialApiSourceLocatorBinding
  );
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const enrichPendingRepo = new SqliteEnrichPendingRepo(database);
  const runtimeNotifier = {
    notify: async () => undefined,
    notifyEntry: async (_entry: EventLogEntry) => undefined
  };

  await seedWorkspaceRun(workspaceRepo, runRepo);

  const evidenceService = new EvidenceService({
    evidenceCapsuleRepo: evidenceRepo,
    eventLogRepo,
    runtimeNotifier,
    generateObjectId: () => EVIDENCE_ID,
    now: () => "2026-05-25T00:00:00.000Z"
  });
  const enqueueEnrichPending = (params: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  }): void =>
    enrichPendingRepo.enqueue({
      workspaceId: params.workspaceId,
      memoryId: params.memoryId,
      runId: params.runId,
      sourceSignalId: params.sourceSignalId,
      enqueuedAt: "2026-05-25T00:00:01.000Z"
    });
  const memoryService = new MemoryService({
    memoryEntryRepo: memoryRepo,
    evidenceService,
    eventLogRepo,
    runtimeNotifier,
    enrichPendingWriter: { enqueue: enqueueEnrichPending },
    generateObjectId: () => MEMORY_ID,
    now: () => "2026-05-25T00:00:00.000Z"
  });
  const router = new MaterializationRouter({
    evidenceService,
    memoryService: {
      create: async (input) => {
        const created = await memoryService.create(input);
        return {
          object_kind: created.object_kind,
          object_id: created.object_id,
          enrichmentEnqueued: input.enqueueEnrichment !== undefined
        };
      }
    },
    synthesisService: {
      create: async () => ({ object_kind: "synthesis_capsule", object_id: "synthesis-1" })
    },
    claimService: {
      create: async () => ({ object_kind: "claim_form", object_id: "claim-1" })
    },
    enrichPendingPort: { enqueue: enqueueEnrichPending },
    handoffGapHandler: new InMemoryHandoffGapHandler(),
    projectionRoutingEnabled: options.projectionRoutingEnabled,
    fullTurnEvidenceExcerpt: true
  });

  return { database, router, memoryRepo, evidenceRepo, eventLogRepo };
}

async function materializeRecallSignal(
  harness: Awaited<ReturnType<typeof createHarness>>,
  signal: CandidateMemorySignal
) {
  const signalRepo = new SqliteSignalRepo(harness.database);
  await signalRepo.create(signal);
  const materialized = await harness.router.materializeSignal(signal);
  if (!materialized.success) return materialized;
  await signalRepo.updateState(signal.signal_id, SignalState.MATERIALIZED);
  const payload = SoulSignalMaterializedPayloadSchema.parse({
    signal_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    created_objects: materialized.created_objects,
    success: true
  });
  await harness.eventLogRepo.append({
    event_type: SignalEventType.SOUL_SIGNAL_MATERIALIZED,
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: "materialization_router",
    payload_json: payload
  });
  return materialized;
}

async function compileRecallSignal(source: string, assertionNeedle: string): Promise<CandidateMemorySignal> {
  const provider = new OfficialApiGardenProvider({
    apiKey: "sk-test",
    extractor: {
      extract: async ({ userPrompt }) => {
        const prompt = JSON.parse(userPrompt) as {
          source_assertions: readonly { readonly assertion_id: number; readonly text: string }[];
        };
        const assertion = prompt.source_assertions.find(({ text }) =>
          text.includes(assertionNeedle)
        );
        if (assertion === undefined) throw new Error("recall assertion missing");
        const quote = assertion.text.replace(/^User:\s*/u, "");
        return {
          rawJson: JSON.stringify({ signals: [{
            signal_kind: "potential_claim",
            object_kind: "fact",
            confidence: 0.9,
            matched_text: quote,
            distilled_fact: quote,
            evidence_refs: [],
            source_memory_refs: [],
            source_locator: {
              contract_version: 2,
              kind: "assertion_catalog",
              assertion_id: assertion.assertion_id
            },
            semantic_factor_graph: {
              schema_version: 1, source_kind: "evidence",
              factors: [{ factor_id: "f0", surface: quote.slice(0, 64), semantic_identity: quote.slice(0, 64).toLowerCase() }],
              variables: [], result_variable_ids: [],
              propositions: [{ proposition_id: "p0", predicate_factor_id: "f0", arguments: [{ position: 0, binding_identity: "assertion", reference_kind: "factor", reference_id: "f0" }] }]
            }
          }] })
        };
      }
    },
    generateSignalId: () => "signal-recall"
  });
  const [signal] = await provider.compile(source, {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    turn_messages: [{ message_id: "user-1", role: "user", content: source }]
  });
  if (signal === undefined) throw new Error("recall signal missing");
  return signal;
}

function createRecallService(
  memoryRepo: SqliteMemoryEntryRepo,
  evidenceRepo: SqliteEvidenceCapsuleRepo
): RecallService {
  const dependencies: RecallServiceDependencies = {
    now: () => "2026-05-25T00:00:02.000Z",
    generateRuntimeId: () => "66666666-6666-4666-8666-666666666666",
    memoryRepo: {
      findByWorkspaceId: memoryRepo.findByWorkspaceId.bind(memoryRepo),
      findByDimension: memoryRepo.findByDimension.bind(memoryRepo),
      findByScopeClass: memoryRepo.findByScopeClass.bind(memoryRepo),
      searchByKeyword: memoryRepo.searchByKeyword.bind(memoryRepo),
      searchByKeywordField: memoryRepo.searchByKeywordField.bind(memoryRepo),
      searchByAnchorField: memoryRepo.searchByAnchorField.bind(memoryRepo),
      searchByKeywordWithinObjectIds: memoryRepo.searchByKeywordWithinObjectIds.bind(memoryRepo),
      findByEvidenceRefs: memoryRepo.findByEvidenceRefs.bind(memoryRepo),
      findBoundEvidenceRefs: memoryRepo.findBoundEvidenceRefs.bind(memoryRepo),
      findByIds: memoryRepo.findByIds.bind(memoryRepo)
    },
    slotRepo: { findByWorkspace: async () => [] },
    eventLogRepo: {
      append: async (entry) => ({
        ...entry,
        event_id: "event-recall",
        created_at: "2026-05-25T00:00:02.000Z",
        revision: 0
      }),
      queryByEntity: async () => []
    },
    evidenceSearchPort: {
      searchByKeyword: evidenceRepo.searchByKeyword.bind(evidenceRepo),
      searchByKeywordField: evidenceRepo.searchByKeywordField.bind(evidenceRepo),
      searchManyByKeywordField: evidenceRepo.searchManyByKeywordField.bind(evidenceRepo),
      findByIds: evidenceRepo.findByIds.bind(evidenceRepo),
      findRecallQualifiedByIds: evidenceRepo.findRecallQualifiedByIds.bind(evidenceRepo),
      findRecallQualifiedFactKeysByIds:
        evidenceRepo.findRecallQualifiedFactKeysByIds.bind(evidenceRepo),
      findSourceAnchorsByIds: evidenceRepo.findSourceAnchorsByIds.bind(evidenceRepo)
    }
  };
  return new RecallService(dependencies);
}
