import { randomUUID } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  ScopeClass,
  SignalSource,
  type CandidateMemorySignal,
  type SoulEmitCandidateSignalResponse,
  type SoulProposeMemoryUpdateResponse,
  type SoulReviewMemoryProposalResponse
} from "@do-soul/alaya-protocol";
import { CoherenceEdgeProducerService, PATH_RELATION_PROPOSE_THRESHOLD } from "@do-soul/alaya-core";
import { type AlayaDaemonRuntime } from "@do-soul/alaya";
import { normalizeSchemaGroundedSignal } from "@do-soul/alaya-soul";
import {
  BENCH_FULL_TURN_CONTENT_KEY,
  BENCH_SEED_MARKER_KEY,
  BENCH_STORED_CONTENT_KEY,
  BENCH_TURN_SEED_INDEX_KEY
} from "./token-economy.js";
import { planSessionCoRecallWarmup } from "./co-recall-warmup.js";
import {
  createUnscoredMaterializedSeedError,
  isUnscoredMaterializedSeedError
} from "./seed-errors.js";
import type {
  BenchDaemonHandle,
  BenchSignalSeedInput,
  BenchSynthesisSeedInput,
  CompileSeedBatchResult,
  CompileSeedSignalDrop,
  SeededMemoryResult,
  SeededSynthesisResult
} from "./daemon-types.js";
import type { SeedObjectKind } from "./seed-rotation.js";

interface CreateBenchSeedOpsInput {
  readonly activeRuntime: AlayaDaemonRuntime;
  readonly activeContext: { workspaceId: string; runId: string };
  readonly callMcpTool: <TOutput>(
    name: string,
    args: Record<string, unknown>
  ) => Promise<TOutput>;
  readonly readMaterializedObjects: (
    signalId: string
  ) => Promise<{ readonly memoryId: string; readonly evidenceId: string | null }>;
  readonly reviewerIdentity: string;
  readonly reviewerToken: string;
}

const SEED_CONTENT_MAX = 15_000;

function clipSeedContent(content: string): {
  readonly safe: string;
  readonly truncated: boolean;
  readonly charsClipped: number;
} {
  if (content.length <= SEED_CONTENT_MAX) {
    return { safe: content, truncated: false, charsClipped: 0 };
  }
  return {
    safe: `${content.slice(0, SEED_CONTENT_MAX)} [truncated at ${SEED_CONTENT_MAX} chars]`,
    truncated: true,
    charsClipped: content.length - SEED_CONTENT_MAX
  };
}

function benchTokenEconomyPayload(input: {
  readonly fullTurnContent: string;
  readonly storedContent: string;
  readonly turnSeedIndex?: number;
  readonly excerptSibling?: string;
  readonly distilledFactSibling?: string;
}): Record<string, unknown> {
  const storedDuplicatesSibling =
    input.storedContent === input.distilledFactSibling ||
    (input.distilledFactSibling === undefined &&
      input.storedContent === input.excerptSibling);
  return {
    [BENCH_SEED_MARKER_KEY]: true,
    ...(input.fullTurnContent === input.excerptSibling
      ? {}
      : { [BENCH_FULL_TURN_CONTENT_KEY]: input.fullTurnContent }),
    ...(storedDuplicatesSibling
      ? {}
      : { [BENCH_STORED_CONTENT_KEY]: input.storedContent }),
    ...(input.turnSeedIndex === undefined
      ? {}
      : { [BENCH_TURN_SEED_INDEX_KEY]: input.turnSeedIndex })
  };
}

function buildSourceMemoryRefsField(
  refs: readonly string[] | undefined
): Record<string, unknown> {
  if (refs === undefined || refs.length === 0) {
    return {};
  }
  const unique = [...new Set(refs.filter((ref) => typeof ref === "string" && ref.length > 0))];
  if (unique.length === 0) {
    return {};
  }
  return { source_memory_refs: unique };
}

const FIRST_CLASS_MEMORY_REF_KEYS = [
  "source_memory_refs",
  "supersedes_refs",
  "exception_to_refs",
  "contradicts_refs",
  "incompatible_with_refs"
] as const;

function stripFirstClassMemoryRefsFromRawPayload(
  rawPayload: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const sanitized = { ...rawPayload };
  for (const key of FIRST_CLASS_MEMORY_REF_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

export function createBenchSeedOps(
  input: CreateBenchSeedOpsInput
): Pick<
  BenchDaemonHandle,
  | "proposeMemory"
  | "proposeMemoryFromSignal"
  | "proposeMemoriesFromCompileSignals"
  | "proposeSynthesis"
  | "accrueSessionCoRecall"
  | "accrueCoherenceCoRecall"
> {
  async function acceptSeededMemory(
    memoryId: string,
    evidenceRef: string
  ): Promise<{ readonly proposalId: string }> {
    const proposeResponse =
      await input.callMcpTool<SoulProposeMemoryUpdateResponse>(
        "soul.propose_memory_update",
        {
          target_object_id: memoryId,
          proposed_changes: {
            domain_tags: ["bench-seed", "bench-reviewed"]
          },
          reason: `bench seed accept for evidence ${evidenceRef}`
        }
      );
    if (proposeResponse.status !== "created") {
      throw new Error(
        `soul.propose_memory_update returned unexpected status=${proposeResponse.status}`
      );
    }

    const reviewResponse =
      await input.callMcpTool<SoulReviewMemoryProposalResponse>(
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
    signalId: string,
    evidenceRef: string
  ): Promise<{
    readonly memoryId: string;
    readonly proposalId: string;
    readonly evidenceId: string | null;
  }> {
    const materialized = await input.readMaterializedObjects(signalId);
    let accepted: { readonly proposalId: string };
    try {
      accepted = await acceptSeededMemory(materialized.memoryId, evidenceRef);
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

  async function proposeMemory(
    content: string,
    evidenceRef: string,
    options: {
      readonly objectKind?: SeedObjectKind;
      readonly distilledFact?: string;
      readonly sourceMemoryRefs?: readonly string[];
    } = {}
  ): Promise<SeededMemoryResult> {
    const objectKind: SeedObjectKind = options.objectKind ?? "fact";
    const wasTruncated = content.length > SEED_CONTENT_MAX;
    const charsClipped = wasTruncated ? content.length - SEED_CONTENT_MAX : 0;
    const safeContent = wasTruncated
      ? `${content.slice(0, SEED_CONTENT_MAX)} [truncated at ${SEED_CONTENT_MAX} chars]`
      : content;
    const safeDistilledFact =
      options.distilledFact === undefined
        ? undefined
        : options.distilledFact.length > SEED_CONTENT_MAX
          ? `${options.distilledFact.slice(0, SEED_CONTENT_MAX)} [truncated at ${SEED_CONTENT_MAX} chars]`
          : options.distilledFact;

    const sourceMemoryRefsField = buildSourceMemoryRefsField(options.sourceMemoryRefs);
    const signalResponse = await input.callMcpTool<SoulEmitCandidateSignalResponse>(
      "soul.emit_candidate_signal",
      {
        signal_kind: "potential_preference",
        object_kind: objectKind,
        scope_hint: ScopeClass.PROJECT,
        domain_tags: ["bench-seed"],
        confidence: 0.9,
        evidence_refs: [evidenceRef],
        ...sourceMemoryRefsField,
        raw_payload: {
          excerpt: safeContent,
          ...(safeDistilledFact === undefined
            ? {}
            : { distilled_fact: safeDistilledFact }),
          ...benchTokenEconomyPayload({
            fullTurnContent: safeContent,
            storedContent: safeDistilledFact ?? safeContent,
            excerptSibling: safeContent,
            distilledFactSibling: safeDistilledFact
          })
        }
      }
    );
    if (signalResponse.status !== "emitted") {
      throw new Error(
        `soul.emit_candidate_signal returned unexpected status=${signalResponse.status}`
      );
    }

    const accepted = await materializeAndAcceptSeed(
      signalResponse.signal_id,
      evidenceRef
    );

    return {
      memoryId: accepted.memoryId,
      signalId: signalResponse.signal_id,
      proposalId: accepted.proposalId,
      evidenceId: accepted.evidenceId,
      truncated: wasTruncated,
      charsClipped
    };
  }

  async function proposeMemoryFromSignal(
    signalInput: BenchSignalSeedInput
  ): Promise<SeededMemoryResult> {
    const wasTruncated = signalInput.turnContent.length > SEED_CONTENT_MAX;
    const charsClipped = wasTruncated
      ? signalInput.turnContent.length - SEED_CONTENT_MAX
      : 0;
    const safeExcerpt = wasTruncated
      ? `${signalInput.turnContent.slice(0, SEED_CONTENT_MAX)} [truncated at ${SEED_CONTENT_MAX} chars]`
      : signalInput.turnContent;
    const safeDistilledFact =
      signalInput.distilledFact.length > SEED_CONTENT_MAX
        ? `${signalInput.distilledFact.slice(0, SEED_CONTENT_MAX)} [truncated at ${SEED_CONTENT_MAX} chars]`
        : signalInput.distilledFact;

    const tokenEconomy = benchTokenEconomyPayload({
      fullTurnContent: safeExcerpt,
      storedContent: safeDistilledFact,
      turnSeedIndex: signalInput.turnSeedIndex,
      ...(signalInput.productionRawPayload === undefined
        ? {
            excerptSibling: safeExcerpt,
            distilledFactSibling: safeDistilledFact
          }
        : {})
    });
    const rawPayload: Record<string, unknown> =
      signalInput.productionRawPayload === undefined
        ? {
            excerpt: safeExcerpt,
            distilled_fact: safeDistilledFact,
            extraction_provider: signalInput.extractionProvider,
            ...tokenEconomy
          }
        : {
            ...stripFirstClassMemoryRefsFromRawPayload(
              signalInput.productionRawPayload
            ),
            extraction_provider: signalInput.extractionProvider,
            ...tokenEconomy
          };

    const sourceMemoryRefsField = buildSourceMemoryRefsField(
      signalInput.sourceMemoryRefs
    );
    const signalResponse = await input.callMcpTool<SoulEmitCandidateSignalResponse>(
      "soul.emit_candidate_signal",
      {
        signal_kind: signalInput.signalKind,
        object_kind: signalInput.objectKind,
        scope_hint: ScopeClass.PROJECT,
        domain_tags: ["bench-seed"],
        confidence: signalInput.confidence,
        evidence_refs: [signalInput.evidenceRef],
        ...sourceMemoryRefsField,
        raw_payload: rawPayload
      }
    );
    if (signalResponse.status !== "emitted") {
      throw new Error(
        `soul.emit_candidate_signal returned unexpected status=${signalResponse.status}`
      );
    }

    const accepted = await materializeAndAcceptSeed(
      signalResponse.signal_id,
      signalInput.evidenceRef
    );

    return {
      memoryId: accepted.memoryId,
      signalId: signalResponse.signal_id,
      proposalId: accepted.proposalId,
      evidenceId: accepted.evidenceId,
      truncated: wasTruncated,
      charsClipped
    };
  }

  async function seedOneCompileSignal(
    signalInput: BenchSignalSeedInput
  ): Promise<
    | { readonly kind: "seeded"; readonly result: SeededMemoryResult }
    | { readonly kind: "dropped"; readonly drop: CompileSeedSignalDrop }
  > {
    const clip = clipSeedContent(signalInput.turnContent);
    const safeDistilledFact =
      signalInput.distilledFact.length > SEED_CONTENT_MAX
        ? `${signalInput.distilledFact.slice(0, SEED_CONTENT_MAX)} [truncated at ${SEED_CONTENT_MAX} chars]`
        : signalInput.distilledFact;
    const tokenEconomy = benchTokenEconomyPayload({
      fullTurnContent: clip.safe,
      storedContent: safeDistilledFact,
      turnSeedIndex: signalInput.turnSeedIndex,
      ...(signalInput.productionRawPayload === undefined
        ? {
            excerptSibling: clip.safe,
            distilledFactSibling: safeDistilledFact
          }
        : {})
    });
    const rawPayload: Record<string, unknown> =
      signalInput.productionRawPayload === undefined
        ? {
            excerpt: clip.safe,
            distilled_fact: safeDistilledFact,
            extraction_provider: signalInput.extractionProvider,
            ...tokenEconomy
          }
        : {
            ...stripFirstClassMemoryRefsFromRawPayload(
              signalInput.productionRawPayload
            ),
            extraction_provider: signalInput.extractionProvider,
            ...tokenEconomy
          };

    const signal: CandidateMemorySignal = normalizeSchemaGroundedSignal(
      CandidateMemorySignalSchema.parse({
        signal_id: `bench_signal_${randomUUID().replace(/-/gu, "")}`,
        workspace_id: input.activeContext.workspaceId,
        run_id: input.activeContext.runId,
        surface_id: null,
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
      })
    );

    const received = await input.activeRuntime.services.signalService.receiveSignal(signal);
    const createdObjects = received.materialization?.created_objects ?? [];
    const memoryObject = createdObjects.find(
      (obj: (typeof createdObjects)[number]) => obj.object_kind === "memory_entry"
    );
    if (memoryObject === undefined) {
      const routingReason = received.materialization?.routing_reason ?? "n/a";
      process.stderr.write(
        `[bench compile-seed] signal ${received.signal.signal_id} ` +
          `triage=${received.triage_result} ` +
          `routing=${routingReason} ` +
          `did not materialize a memory_entry — skipped, turn batch continues\n`
      );
      return {
        kind: "dropped",
        drop: {
          reason: "candidate_absent",
          detail: `triage=${received.triage_result} routing=${routingReason}`
        }
      };
    }
    const evidenceObject = createdObjects.find(
      (obj: (typeof createdObjects)[number]) => obj.object_kind === "evidence_capsule"
    );
    let accepted: { readonly proposalId: string };
    try {
      accepted = await acceptSeededMemory(
        memoryObject.object_id,
        signalInput.evidenceRef
      );
    } catch (error) {
      throw createUnscoredMaterializedSeedError({
        memoryId: memoryObject.object_id,
        evidenceRef: signalInput.evidenceRef,
        cause: error
      });
    }
    return {
      kind: "seeded",
      result: {
        memoryId: memoryObject.object_id,
        signalId: received.signal.signal_id,
        proposalId: accepted.proposalId,
        evidenceId: evidenceObject?.object_id ?? null,
        truncated: clip.truncated,
        charsClipped: clip.charsClipped
      }
    };
  }

  async function proposeMemoriesFromCompileSignals(
    inputs: readonly BenchSignalSeedInput[]
  ): Promise<CompileSeedBatchResult> {
    if (inputs.length === 0) {
      return { seeds: [], dropped: [] };
    }
    const results: SeededMemoryResult[] = [];
    const dropped: CompileSeedSignalDrop[] = [];
    for (const signalInput of inputs) {
      try {
        const seeded = await seedOneCompileSignal(signalInput);
        if (seeded.kind === "dropped") {
          dropped.push(seeded.drop);
          continue;
        }
        results.push(seeded.result);
      } catch (error) {
        if (isUnscoredMaterializedSeedError(error)) {
          throw error;
        }
        const detail = error instanceof Error ? error.message : String(error);
        dropped.push({ reason: "materialization_error", detail });
        process.stderr.write(
          `[bench compile-seed] signal evidence_ref=${signalInput.evidenceRef} ` +
            `threw before memory_entry creation — isolated per-signal, turn batch ` +
            `continues: ${detail}\n`
        );
      }
    }
    return { seeds: results, dropped };
  }

  async function proposeSynthesis(
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

  async function accrueSessionCoRecall(
    memberMemoryIds: readonly string[]
  ) {
    const plan = planSessionCoRecallWarmup(
      memberMemoryIds,
      PATH_RELATION_PROPOSE_THRESHOLD
    );
    if (plan === null) {
      return { pairsObserved: 0, minted: 0, belowThreshold: 0 };
    }
    const service = input.activeRuntime.services.pathRelationProposalService;
    const beforeCounter = await service.counterSize();
    for (let replay = 0; replay < plan.replayCount; replay += 1) {
      for (const pair of plan.pairs) {
        await service.onCoUsage(
          [pair.lowMemoryId, pair.highMemoryId],
          input.activeContext.workspaceId
        );
      }
    }
    const afterCounter = await service.counterSize();
    const residualPending = Math.max(0, afterCounter - beforeCounter);
    const minted = Math.max(0, plan.pairs.length - residualPending);
    return {
      pairsObserved: plan.pairs.length,
      minted,
      belowThreshold: residualPending
    };
  }

  async function accrueCoherenceCoRecall(
    members: readonly { readonly memoryId: string; readonly sessionId: string }[],
    options: {
      readonly floor: number;
      readonly capPerNode: number;
      readonly crossSessionOnly: boolean;
    }
  ): Promise<{
    readonly coherentPairs: number;
    readonly keptPairs: number;
    readonly minted: number;
  }> {
    const embeddingRecallService = input.activeRuntime.services.embeddingRecallService;
    if (embeddingRecallService === undefined || members.length < 2) {
      return { coherentPairs: 0, keptPairs: 0, minted: 0 };
    }
    const producer = new CoherenceEdgeProducerService({
      pairSource: embeddingRecallService,
      mintPort: input.activeRuntime.services.pathRelationProposalService,
      warn: (message, meta) => console.error(`[coherence] ${message}`, meta)
    });
    return producer.crystallize({
      workspaceId: input.activeContext.workspaceId,
      runId: input.activeContext.runId,
      objects: members.map((member) => ({
        objectId: member.memoryId,
        sessionId: member.sessionId
      })),
      floor: options.floor,
      capPerNode: options.capPerNode,
      crossSessionOnly: options.crossSessionOnly
    });
  }

  return {
    proposeMemory,
    proposeMemoryFromSignal,
    proposeMemoriesFromCompileSignals,
    proposeSynthesis,
    accrueSessionCoRecall,
    accrueCoherenceCoRecall
  };
}
