import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  CandidateMemorySignalSchema,
  ScopeClass,
  SignalSource,
  type CandidateMemorySignal,
  type SoulEmitCandidateSignalResponse,
  type SoulProposeMemoryUpdateResponse,
  type SoulReviewMemoryProposalResponse
} from "@do-soul/alaya-protocol";
import { normalizeSchemaGroundedSignal } from "@do-soul/alaya-soul";
import { initDatabase, SqliteMemoryHqRepo } from "@do-soul/alaya-storage";
import {
  createUnscoredMaterializedSeedError,
  isUnscoredMaterializedSeedError
} from "./seed-errors.js";
import {
  benchTokenEconomyPayload,
  buildSourceMemoryRefsField,
  clipSeedContent,
  SEED_CONTENT_MAX,
  stripFirstClassMemoryRefsFromRawPayload
} from "./daemon-seed-helpers.js";
import type {
  BenchSignalSeedInput,
  BenchSynthesisSeedInput,
  CompileSeedBatchResult,
  CompileSeedSignalDrop,
  SeededMemoryResult,
  SeededSynthesisResult
} from "./daemon-types.js";
import type { CreateBenchSeedOpsInput } from "./daemon-seed-ops-types.js";
import type { SeedObjectKind } from "./seed-rotation.js";
import {
  isRawPayloadBoundError,
  projectCompileRawPayload
} from "./seeding/compile-raw-payload.js";

export {
  accrueAnswersWithCoRelevance,
  accrueCoherenceCoRecall,
  accrueSessionCoRecall
} from "./daemon-edge-accrual.js";

type AcceptedSeedMemory = { readonly proposalId: string };
type MaterializedAcceptedSeed = {
  readonly memoryId: string;
  readonly proposalId: string;
  readonly evidenceId: string | null;
};
type BenchSignalMaterializedObject = {
  readonly object_kind: string;
  readonly object_id: string;
};
type BenchSignalReceiveResult = {
  readonly signal: { readonly signal_id: string };
  readonly triage_result: string;
  readonly materialization: {
    readonly routing_reason: string;
    readonly created_objects: readonly BenchSignalMaterializedObject[];
  } | null;
};
const BENCH_ANSWER_HQ_MAX = 5;

export async function acceptSeededMemory(
  input: CreateBenchSeedOpsInput,
  memoryId: string,
  evidenceRef: string
): Promise<AcceptedSeedMemory> {
  const proposeResponse = await input.callMcpTool<SoulProposeMemoryUpdateResponse>(
    "soul.propose_memory_update",
    {
      target_object_id: memoryId,
      proposed_changes: { domain_tags: ["bench-seed", "bench-reviewed"] },
      reason: `bench seed accept for evidence ${evidenceRef}`
    }
  );
  if (proposeResponse.status !== "created") {
    throw new Error(
      `soul.propose_memory_update returned unexpected status=${proposeResponse.status}`
    );
  }

  const reviewResponse = await input.callMcpTool<SoulReviewMemoryProposalResponse>(
    "soul.review_memory_proposal",
    {
      proposal_id: proposeResponse.proposal_id,
      verdict: "accept",
      reason: "bench seed auto-accept",
      reviewer_identity: input.reviewerIdentity,
      reviewer_token: input.reviewerToken
    }
  );
  if (reviewResponse.resolution_state !== "accepted") {
    throw new Error(
      `soul.review_memory_proposal returned unexpected state=${reviewResponse.resolution_state}`
    );
  }
  return { proposalId: proposeResponse.proposal_id };
}

async function materializeAndAcceptSeed(
  input: CreateBenchSeedOpsInput,
  signalId: string,
  evidenceRef: string
): Promise<MaterializedAcceptedSeed> {
  const materialized = await input.readMaterializedObjects(signalId);
  let accepted: AcceptedSeedMemory;
  try {
    accepted = await acceptSeededMemory(input, materialized.memoryId, evidenceRef);
  } catch (error) {
    throw createUnscoredMaterializedSeedError({
      memoryId: materialized.memoryId,
      evidenceRef,
      cause: error
    });
  }
  return {
    memoryId: materialized.memoryId,
    proposalId: accepted.proposalId,
    evidenceId: materialized.evidenceId
  };
}

function clippedDistilledFact(value: string): string {
  return value.length > SEED_CONTENT_MAX
    ? `${value.slice(0, SEED_CONTENT_MAX)} [truncated at ${SEED_CONTENT_MAX} chars]`
    : value;
}

function buildSignalRawPayload(
  signalInput: BenchSignalSeedInput,
  safeExcerpt: string,
  safeDistilledFact: string
): Record<string, unknown> {
  const tokenEconomy = benchTokenEconomyPayload({
    fullTurnContent: safeExcerpt,
    storedContent: safeDistilledFact,
    turnSeedIndex: signalInput.turnSeedIndex
  });
  if (signalInput.productionRawPayload === undefined) {
    return {
      excerpt: safeExcerpt,
      distilled_fact: safeDistilledFact,
      extraction_provider: signalInput.extractionProvider,
      ...tokenEconomy
    };
  }
  return {
    ...stripFirstClassMemoryRefsFromRawPayload(signalInput.productionRawPayload),
    extraction_provider: signalInput.extractionProvider,
    ...tokenEconomy
  };
}

export async function proposeMemory(
  input: CreateBenchSeedOpsInput,
  content: string,
  evidenceRef: string,
  options: {
    readonly objectKind?: SeedObjectKind;
    readonly distilledFact?: string;
    readonly sourceMemoryRefs?: readonly string[];
  } = {}
): Promise<SeededMemoryResult> {
  const clip = clipSeedContent(content);
  const safeDistilledFact =
    options.distilledFact === undefined
      ? undefined
      : clippedDistilledFact(options.distilledFact);
  const signalResponse = await input.callMcpTool<SoulEmitCandidateSignalResponse>(
    "soul.emit_candidate_signal",
    {
      signal_kind: "potential_preference",
      object_kind: options.objectKind ?? "fact",
      scope_hint: ScopeClass.PROJECT,
      domain_tags: ["bench-seed"],
      confidence: 0.9,
      evidence_refs: [evidenceRef],
      ...buildSourceMemoryRefsField(options.sourceMemoryRefs),
      raw_payload: {
        excerpt: clip.safe,
        ...(safeDistilledFact === undefined
          ? {}
          : { distilled_fact: safeDistilledFact }),
        ...benchTokenEconomyPayload({
          fullTurnContent: clip.safe,
          storedContent: safeDistilledFact ?? clip.safe
        })
      }
    }
  );
  if (signalResponse.status !== "emitted") {
    throw new Error(
      `soul.emit_candidate_signal returned unexpected status=${signalResponse.status}`
    );
  }
  return seededMemoryResult(
    signalResponse.signal_id,
    await materializeAndAcceptSeed(input, signalResponse.signal_id, evidenceRef),
    clip
  );
}

export async function proposeMemoryFromSignal(
  input: CreateBenchSeedOpsInput,
  signalInput: BenchSignalSeedInput
): Promise<SeededMemoryResult> {
  const clip = clipSeedContent(signalInput.turnContent);
  const safeDistilledFact = clippedDistilledFact(signalInput.distilledFact);
  const signalResponse = await input.callMcpTool<SoulEmitCandidateSignalResponse>(
    "soul.emit_candidate_signal",
    {
      signal_kind: signalInput.signalKind,
      object_kind: signalInput.objectKind,
      scope_hint: ScopeClass.PROJECT,
      domain_tags: ["bench-seed"],
      confidence: signalInput.confidence,
      evidence_refs: [signalInput.evidenceRef],
      ...buildSourceMemoryRefsField(signalInput.sourceMemoryRefs),
      raw_payload: buildSignalRawPayload(signalInput, clip.safe, safeDistilledFact)
    }
  );
  if (signalResponse.status !== "emitted") {
    throw new Error(
      `soul.emit_candidate_signal returned unexpected status=${signalResponse.status}`
    );
  }
  return seededMemoryResult(
    signalResponse.signal_id,
    await materializeAndAcceptSeed(input, signalResponse.signal_id, signalInput.evidenceRef),
    clip
  );
}

function seededMemoryResult(
  signalId: string,
  accepted: MaterializedAcceptedSeed,
  clip: ReturnType<typeof clipSeedContent>
): SeededMemoryResult {
  return {
    memoryId: accepted.memoryId,
    signalId,
    proposalId: accepted.proposalId,
    evidenceId: accepted.evidenceId,
    truncated: clip.truncated,
    charsClipped: clip.charsClipped
  };
}

type CompileSeedResult =
  | { readonly kind: "seeded"; readonly result: SeededMemoryResult }
  | { readonly kind: "dropped"; readonly drop: CompileSeedSignalDrop };

function buildCompileSignal(
  input: CreateBenchSeedOpsInput,
  signalInput: BenchSignalSeedInput,
  rawPayload: Record<string, unknown>
): CandidateMemorySignal {
  const candidate = {
    signal_id: `bench_signal_${randomUUID().replace(/-/gu, "")}`,
    workspace_id: input.activeContext.workspaceId,
    run_id: input.activeContext.runId,
    surface_id: signalInput.surfaceId ?? null,
    source: SignalSource.GARDEN_COMPILE,
    signal_kind: signalInput.signalKind,
    object_kind: signalInput.objectKind,
    scope_hint: ScopeClass.PROJECT,
    domain_tags: ["bench-seed"],
    confidence: signalInput.confidence,
    evidence_refs: [signalInput.evidenceRef],
    ...buildSourceMemoryRefsField(signalInput.sourceMemoryRefs),
    raw_payload: rawPayload,
    created_at: new Date().toISOString()
  };
  try {
    return normalizeSchemaGroundedSignal(CandidateMemorySignalSchema.parse(candidate));
  } catch (error) {
    if (!isRawPayloadBoundError(error)) throw error;
    return normalizeSchemaGroundedSignal(CandidateMemorySignalSchema.parse({
      ...candidate,
      raw_payload: projectCompileRawPayload(rawPayload)
    }));
  }
}

function droppedCompileSignal(
  signalId: string,
  triageResult: string,
  routingReason: string
): CompileSeedResult {
  process.stderr.write(
    `[bench compile-seed] signal ${signalId} ` +
      `triage=${triageResult} routing=${routingReason} ` +
      `did not materialize a memory_entry — skipped, turn batch continues\n`
  );
  return {
    kind: "dropped",
    drop: {
      reason: "candidate_absent",
      detail: `triage=${triageResult} routing=${routingReason}`
    }
  };
}

async function seedOneCompileSignal(
  input: CreateBenchSeedOpsInput,
  signalInput: BenchSignalSeedInput
): Promise<CompileSeedResult> {
  const clip = clipSeedContent(signalInput.turnContent);
  const safeDistilledFact = clippedDistilledFact(signalInput.distilledFact);
  const signal = buildCompileSignal(
    input,
    signalInput,
    buildSignalRawPayload(signalInput, clip.safe, safeDistilledFact)
  );
  const received = (await input.activeRuntime.services.signalService.receiveSignal(
    signal
  )) as BenchSignalReceiveResult;
  const createdObjects: readonly BenchSignalMaterializedObject[] =
    received.materialization?.created_objects ?? [];
  const memoryObject = createdObjects.find((obj) => obj.object_kind === "memory_entry");
  if (memoryObject === undefined) {
    return droppedCompileSignal(
      received.signal.signal_id,
      received.triage_result,
      received.materialization?.routing_reason ?? "n/a"
    );
  }

  const evidenceObject = createdObjects.find(
    (obj) => obj.object_kind === "evidence_capsule"
  );
  const accepted = await acceptCompileSeededMemory(
    input,
    memoryObject.object_id,
    signalInput.evidenceRef
  );
  await persistBenchAnswerHq(input, memoryObject.object_id, signalInput);
  return {
    kind: "seeded",
    result: seededMemoryResult(
      received.signal.signal_id,
      {
        memoryId: memoryObject.object_id,
        proposalId: accepted.proposalId,
        evidenceId: evidenceObject?.object_id ?? null
      },
      clip
    )
  };
}

async function persistBenchAnswerHq(
  input: CreateBenchSeedOpsInput,
  memoryId: string,
  signalInput: BenchSignalSeedInput
): Promise<void> {
  const hqs = collectBenchAnswerHqs(signalInput);
  if (hqs.length === 0) return;
  const repo = new SqliteMemoryHqRepo(
    initDatabase({ filename: join(input.dataDir, "alaya.db") })
  );
  const now = new Date().toISOString();
  await repo.upsert({
    object_id: memoryId,
    workspace_id: input.activeContext.workspaceId,
    hqs,
    created_at: now,
    updated_at: now
  });
}

function collectBenchAnswerHqs(signalInput: BenchSignalSeedInput): readonly string[] {
  const values = new Set<string>();
  for (const raw of readStringArrayField(signalInput.productionRawPayload, "hqs")) {
    addBenchAnswerHq(values, raw);
  }
  for (const raw of readStringArrayField(signalInput.productionRawPayload, "hypothetical_questions")) {
    addBenchAnswerHq(values, raw);
  }
  for (const raw of readStringArrayField(signalInput.productionRawPayload, "hypotheticalQuestions")) {
    addBenchAnswerHq(values, raw);
  }
  addBenchAnswerHq(values, signalInput.distilledFact);
  return [...values].slice(0, BENCH_ANSWER_HQ_MAX);
}

function readStringArrayField(
  rawPayload: Readonly<Record<string, unknown>> | undefined,
  key: string
): readonly string[] {
  const value = rawPayload?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function addBenchAnswerHq(values: Set<string>, value: string): void {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length > 0) {
    values.add(normalized);
  }
}

async function acceptCompileSeededMemory(
  input: CreateBenchSeedOpsInput,
  memoryId: string,
  evidenceRef: string
): Promise<AcceptedSeedMemory> {
  try {
    return await acceptSeededMemory(input, memoryId, evidenceRef);
  } catch (error) {
    throw createUnscoredMaterializedSeedError({ memoryId, evidenceRef, cause: error });
  }
}

export async function proposeMemoriesFromCompileSignals(
  input: CreateBenchSeedOpsInput,
  inputs: readonly BenchSignalSeedInput[]
): Promise<CompileSeedBatchResult> {
  if (inputs.length === 0) {
    return { seeds: [], dropped: [] };
  }
  const seeds: SeededMemoryResult[] = [];
  const dropped: CompileSeedSignalDrop[] = [];
  for (const signalInput of inputs) {
    const result = await seedCompileSignalSafely(input, signalInput);
    if (result.kind === "dropped") {
      dropped.push(result.drop);
    } else {
      seeds.push(result.result);
    }
  }
  return { seeds, dropped };
}

async function seedCompileSignalSafely(
  input: CreateBenchSeedOpsInput,
  signalInput: BenchSignalSeedInput
): Promise<CompileSeedResult> {
  try {
    return await seedOneCompileSignal(input, signalInput);
  } catch (error) {
    if (isUnscoredMaterializedSeedError(error)) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[bench compile-seed] signal evidence_ref=${signalInput.evidenceRef} ` +
        `threw before memory_entry creation — isolated per-signal, turn batch ` +
        `continues: ${detail}\n`
    );
    return { kind: "dropped", drop: { reason: "materialization_drop", detail } };
  }
}

export async function proposeSynthesis(
  input: CreateBenchSeedOpsInput,
  synthesisInput: BenchSynthesisSeedInput
): Promise<SeededSynthesisResult> {
  if (synthesisInput.evidenceRefs.length < 2) {
    throw new Error(
      `proposeSynthesis requires >= 2 evidence_refs; got ${synthesisInput.evidenceRefs.length}.`
    );
  }
  const synthesis = await input.activeRuntime.services.synthesisService.create({
    created_by: "bench_synthesis_seed",
    topic_key: synthesisInput.topicKey,
    synthesis_type: "cross_evidence",
    summary: synthesisInput.summary,
    evidence_refs: [...synthesisInput.evidenceRefs],
    source_memory_refs: [],
    workspace_id: input.activeContext.workspaceId,
    run_id: input.activeContext.runId
  });
  return { synthesisId: synthesis.object_id };
}
