import { describe, expect, it, vi } from "vitest";
import {
  EventPublisher,
  type RuntimeNotifier
} from "@do-soul/alaya-core";
import {
  RunMode,
  RunState,
  SignalEventType,
  SignalState,
  SoulSignalMaterializedPayloadSchema,
  WorkspaceKind,
  WorkspaceState,
  parseVerifiedUserAssertionSourceHash,
  type CandidateMemorySignal,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import { initDatabase } from "@do-soul/alaya-storage";
import {
  buildEvidenceInput,
  OfficialApiGardenProvider
} from "@do-soul/alaya-soul";
import { createKnowledgeFoundation } from
  "../../../runtime/daemon/wiring/daemon-knowledge-foundation.js";
import { createDaemonRepositories } from
  "../../../runtime/daemon/wiring/daemon-repositories.js";

describe("daemon knowledge foundation", () => {
  it("forms Fact Keys for verified user assertions without a model proposal", async () => {
    const harness = await createHarness();
    try {
      const signal = await compileVerifiedAssertionSignal("I have a dog.");
      await harness.repositories.signalRepo.create(signal);
      const evidence = await harness.foundation.evidenceService.create(
        buildEvidenceInput(signal, undefined, { fullTurnExcerpt: true })
      );
      await harness.repositories.signalRepo.updateState(
        signal.signal_id,
        SignalState.MATERIALIZED
      );
      await appendMaterializationEvent(harness.repositories, signal, evidence);

      const qualified = await harness.repositories.evidenceCapsuleRepo
        .findRecallQualifiedFactKeysByIds("workspace-1", [evidence.object_id]);

      expect(parseVerifiedUserAssertionSourceHash(evidence.source_hash)?.version).toBe(2);
      expect(qualified.map((row) => row.matched_projection?.content))
        .toContain("I have a dog");
      expect(qualified[0]?.matched_fact_frame?.slots).toEqual([
        { role: "subject", text: "I" },
        { role: "relation", text: "have" },
        { role: "value", text: "a dog" }
      ]);
    } finally {
      harness.database.close();
    }
  });
});

async function createHarness() {
  const database = initDatabase({ filename: ":memory:" });
  const runtimeNotifier: RuntimeNotifier = {
    notify: vi.fn(),
    notifyEntry: vi.fn()
  };
  const warn = vi.fn();
  const repositories = createDaemonRepositories({ database, warn });
  await seedWorkspaceRun(repositories);
  const eventPublisher = new EventPublisher({
    eventLogRepo: repositories.eventLogRepo,
    runHotStateService: { apply: vi.fn() },
    runtimeNotifier
  });
  const foundation = createKnowledgeFoundation({
    ...repositories,
    database,
    filesDirectory: "/tmp/alaya-daemon-knowledge-foundation-test",
    runtimeNotifier,
    configPaths: testConfigPaths(),
    warnLogger: testWarnLogger(warn) as never
  }, eventPublisher);
  return { database, foundation, repositories };
}

function testConfigPaths() {
  const root = "/tmp/alaya-daemon-knowledge-foundation-test";
  return {
    configDir: root,
    tomlPath: `${root}/config.toml`,
    envPath: `${root}/.env`,
    auditDir: `${root}/audit`,
    secretsDir: `${root}/secrets`,
    operationsDir: `${root}/operations`
  };
}

function testWarnLogger(warn: ReturnType<typeof vi.fn>) {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    fatal: vi.fn()
  };
}

async function compileVerifiedAssertionSignal(
  assertion: string
): Promise<Readonly<CandidateMemorySignal>> {
  const provider = new OfficialApiGardenProvider({
    apiKey: "sk-test",
    generateSignalId: () => "signal-verified-assertion",
    extractor: { extract: async ({ userPrompt }) => {
      const request = JSON.parse(userPrompt) as {
        readonly source_assertions: readonly {
          readonly assertion_id: number;
          readonly text: string;
        }[];
      };
      const source = request.source_assertions.find(({ text }) => text.includes(assertion));
      if (source === undefined) throw new Error("verified assertion source missing");
      return { rawJson: JSON.stringify({ signals: [openSignal(assertion, source.assertion_id)] }) };
    } }
  });
  const [signal] = await provider.compile(assertion, {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    turn_messages: [{ message_id: "user-1", role: "user", content: assertion }]
  });
  if (signal === undefined) throw new Error("verified assertion signal missing");
  return signal;
}

function openSignal(assertion: string, assertionId: number) {
  const factor = assertion.slice(0, 64);
  return {
    signal_kind: "potential_claim",
    object_kind: "fact",
    confidence: 0.9,
    matched_text: assertion,
    source_locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: assertionId
    },
    semantic_factor_graph: {
      schema_version: 1,
      source_kind: "evidence",
      factors: [{ factor_id: "f0", surface: factor, semantic_identity: factor.toLowerCase() }],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "p0",
        predicate_factor_id: "f0",
        arguments: [{
          position: 0,
          binding_identity: "assertion",
          reference_kind: "factor",
          reference_id: "f0"
        }]
      }]
    }
  };
}

async function appendMaterializationEvent(
  repositories: ReturnType<typeof createDaemonRepositories>,
  signal: Readonly<CandidateMemorySignal>,
  evidence: Readonly<EvidenceCapsule>
): Promise<void> {
  await repositories.eventLogRepo.append({
    event_type: SignalEventType.SOUL_SIGNAL_MATERIALIZED,
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: "materialization_router",
    payload_json: SoulSignalMaterializedPayloadSchema.parse({
      signal_id: signal.signal_id,
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      created_objects: [{ object_kind: evidence.object_kind, object_id: evidence.object_id }],
      success: true
    })
  });
}

async function seedWorkspaceRun(
  repositories: ReturnType<typeof createDaemonRepositories>
): Promise<void> {
  await repositories.workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace-1",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await repositories.runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run-1",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}
