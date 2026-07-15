import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunMode,
  RunState,
  SignalEventType,
  SignalState,
  SoulSignalMaterializedPayloadSchema,
  SoulSignalNormalizedPayloadSchema,
  SoulSignalTriagedPayloadSchema,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import type {
  SourceGroundingDeferEnqueueInput,
  SourceGroundingDeferEventInput
} from "@do-soul/alaya-core";
import {
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteSourceGroundingDeferQueueRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-soul/alaya-storage";
import { createSourceGroundingDeferTransitions } from "../../../runtime/source-grounding-defer/transitions.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

export function closeTestDatabases(): void {
  for (const database of databases) database.close();
  databases.clear();
}

export function reconcile(
  transitions: ReturnType<typeof createSourceGroundingDeferTransitions>,
  view: NonNullable<ReturnType<SqliteSourceGroundingDeferQueueRepo["get"]>>,
  marker: string
) {
  return transitions.reconcileStaleClaim({
    workspace_id: "workspace-1",
    signal_id: "signal-1",
    claim_token_fingerprint: view.claim_token_fingerprint!,
    claim_expires_at: view.claim_expires_at!,
    expired_before: "2026-07-15T00:00:00.000Z",
    event: normalizedEvent({ reconciliation: marker })
  });
}

export async function createFileCompetitionHarness() {
  const directory = await mkdtemp(join(tmpdir(), "alaya-defer-competition-"));
  const filename = join(directory, "competition.sqlite");
  const first = initDatabase({ filename });
  const second = initDatabase({ filename });
  databases.add(first);
  databases.add(second);
  await seedWorkspaceAndRun(first);
  const firstHarness = await createConnectionHarness(first, true);
  const secondHarness = await createConnectionHarness(second, false);
  return {
    first: firstHarness,
    second: secondHarness,
    close: async () => {
      first.close();
      second.close();
      databases.delete(first);
      databases.delete(second);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function createConnectionHarness(
  database: ReturnType<typeof initDatabase>,
  seed: boolean
) {
  const signalRepo = new SqliteSignalRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const queueRepo = new SqliteSourceGroundingDeferQueueRepo(database);
  if (seed) {
    await signalRepo.create(createSignal());
    await signalRepo.updateState("signal-1", SignalState.DEFERRED);
    queueRepo.enqueue(queueEntry());
  }
  return {
    eventLogRepo,
    queueRepo,
    transitions: createSourceGroundingDeferTransitions({ eventLogRepo, signalRepo, queueRepo })
  };
}

export async function createHarness(
  state: typeof SignalState[keyof typeof SignalState],
  queued: boolean,
  queueCap?: number
) {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  await seedWorkspaceAndRun(database);
  const signalRepo = new SqliteSignalRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const queueRepo = new SqliteSourceGroundingDeferQueueRepo(database, queueCap);
  const signal = createSignal();
  await signalRepo.create(signal);
  await signalRepo.updateState(signal.signal_id, state);
  if (queued) queueRepo.enqueue(queueEntry());
  return {
    database,
    signal: { ...signal, signal_state: state },
    signalRepo,
    eventLogRepo,
    queueRepo,
    transitions: createSourceGroundingDeferTransitions({ eventLogRepo, signalRepo, queueRepo })
  };
}

async function seedWorkspaceAndRun(database: ReturnType<typeof initDatabase>): Promise<void> {
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

export function createSignal(signalId = "signal-1"): CandidateMemorySignal {
  return {
    signal_id: signalId,
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    signal_state: SignalState.EMITTED,
    object_kind: "constraint",
    scope_hint: null,
    domain_tags: [],
    confidence: 0.9,
    evidence_refs: ["evidence-1"],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: { full_turn_content: "original" },
    created_at: "2026-07-15T00:00:00.000Z"
  };
}

function queueEntry(): SourceGroundingDeferEnqueueInput {
  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    defer_reason: "source_assertion_incomplete",
    enqueued_at: "2026-07-15T00:00:00.000Z"
  };
}

export function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function eventBase(
  event_type: SourceGroundingDeferEventInput["event_type"],
  payload_json: SourceGroundingDeferEventInput["payload_json"],
  signalId = "signal-1"
): SourceGroundingDeferEventInput {
  return {
    event_type,
    entity_type: "candidate_memory_signal",
    entity_id: signalId,
    workspace_id: "workspace-1",
    run_id: "run-1",
    caused_by: "test",
    payload_json
  };
}

export function normalizedEvent(normalized_fields: object) {
  return eventBase(SignalEventType.SOUL_SIGNAL_NORMALIZED, SoulSignalNormalizedPayloadSchema.parse({
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    normalized_fields
  }));
}

export function deferredEvent(signalId = "signal-1") {
  return eventBase(SignalEventType.SOUL_SIGNAL_TRIAGED, SoulSignalTriagedPayloadSchema.parse({
    signal_id: signalId,
    workspace_id: "workspace-1",
    run_id: "run-1",
    triage_result: "deferred",
    defer_class: "source_grounding",
    defer_reason: "source_assertion_incomplete"
  }), signalId);
}

export function materializedEvent(signalId = "signal-1") {
  return eventBase(SignalEventType.SOUL_SIGNAL_MATERIALIZED, SoulSignalMaterializedPayloadSchema.parse({
    signal_id: signalId,
    workspace_id: "workspace-1",
    run_id: "run-1",
    created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }],
    success: true
  }), signalId);
}

export function failedMaterializationEvent() {
  return eventBase(
    SignalEventType.SOUL_SIGNAL_MATERIALIZATION_FAILED,
    SoulSignalMaterializedPayloadSchema.parse({
      signal_id: "signal-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      created_objects: [{ object_kind: "memory_entry", object_id: "partial-memory" }],
      success: false,
      error: "uncertain materialization failure"
    })
  );
}

export async function signalEvents(harness: Awaited<ReturnType<typeof createHarness>>) {
  return await harness.eventLogRepo.queryByEntityAll("candidate_memory_signal", "signal-1");
}
