import type { MemoryEntry, RecallPolicy } from "@do-soul/alaya-protocol";
import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import { hashMemoryContent } from "../../embedding-recall/helpers.js";
import { RecallService } from "../../recall/recall-service.js";
import type { RecallResult } from "../../recall/runtime/recall-service-types.js";
import { stableStringify } from "../../shared/stable-stringify.js";
import { createEmbeddingRecord } from "../embedding-recall/embedding-recall-test-helpers.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

export const YOGA_OBJECT_ID = "memory-canonical";
export const YOGA_CONTENT = "I take yoga classes at Serenity Yoga.";
export const YOGA_QUERY = "Where do I take yoga classes?";
export const SHADOW_OFF_SHA = "f29002ba9480b267106e38128a91eec1ebe5917d";
export const QUERY_TIMEOUT_MS = 2500;
export const NEUTRALITY_QUERY_ID = "neutrality-query";

export type ProviderEmbedCall = Readonly<{
  readonly texts: readonly string[];
  readonly timeoutMs: number;
}>;

export type RepoRead = Readonly<{
  readonly method: "listByObjectIds" | "listByWorkspace";
  readonly workspaceId: string;
  readonly objectIds?: readonly string[];
  readonly options?: unknown;
}>;

export type PortTrace = Readonly<{
  readonly provider_embed_texts: readonly ProviderEmbedCall[];
  readonly repo_reads: readonly RepoRead[];
  readonly repo_writes: readonly never[];
}>;

export type NeutralityRun = Readonly<{
  readonly public_delivery: unknown;
  readonly membership: readonly string[];
  readonly order: readonly string[];
  readonly receipt: unknown;
  readonly trace: PortTrace;
}>;

export type NeutralityBundle = Readonly<{
  readonly miss: NeutralityRun;
  readonly hit: NeutralityRun;
}>;

export function yogaMemory(): MemoryEntry {
  return createMemoryEntry({
    object_id: YOGA_OBJECT_ID,
    content: YOGA_CONTENT
  });
}

export async function runYogaNeutralityBundle(): Promise<NeutralityBundle> {
  const memory = yogaMemory();
  const ports = createObservableEmbeddingPorts(memory);
  const { dependencies } = createDependencies([memory]);
  const embeddingRecallService = new EmbeddingRecallService({
    embeddingRepo: {
      listByObjectIds: ports.listByObjectIds,
      listByWorkspace: ports.listByWorkspace
    },
    provider: {
      providerKind: "openai",
      modelId: "text-embedding-3-small",
      schemaVersion: 1,
      isAvailable: true,
      embedTexts: ports.embedTexts
    },
    eventLogRepo: dependencies.eventLogRepo,
    generateQueryId: () => NEUTRALITY_QUERY_ID,
    now: dependencies.now,
    queryTimeoutMs: QUERY_TIMEOUT_MS
  });
  const service = new RecallService({
    ...dependencies,
    defaultPolicyDecorator: (policy) => policy,
    embeddingRecallService,
    memoryRepo: {
      ...dependencies.memoryRepo,
      findByIds: async (_workspaceId, ids) =>
        [memory].filter((entry) => ids.includes(entry.object_id))
    }
  });
  const params = yogaRecallParams(service);
  const missResult = await service.recall(params);
  const miss = captureRun(missResult, ports.drain());
  const hitResult = await service.recall(params);
  const hit = captureRun(hitResult, ports.drain());
  return Object.freeze({ miss, hit });
}

export function stringifyNeutralityRun(run: NeutralityRun): string {
  return stableStringify(run);
}

function yogaRecallParams(service: RecallService) {
  const taskSurface = {
    ...createTaskSurface(),
    display_name: YOGA_QUERY
  };
  const base = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
  return {
    taskSurface,
    workspaceId: "workspace-1" as const,
    strategy: "analyze" as const,
    policyOverride: enableEmbedding(base)
  };
}

function enableEmbedding(policy: Readonly<RecallPolicy>): RecallPolicy {
  return overridePolicy(policy, {
    coarse_filter: {
      ...policy.coarse_filter,
      semantic_supplement: {
        ...policy.coarse_filter.semantic_supplement,
        enabled: true,
        max_supplement: 5,
        embedding_enabled: true,
        injection_cap: 0
      }
    }
  });
}

function captureRun(result: RecallResult, trace: PortTrace): NeutralityRun {
  const membership = result.candidates.map((candidate) => candidate.object_id);
  return Object.freeze({
    public_delivery: publicRecallDelivery(result),
    membership,
    order: membership,
    receipt: publicRecallReceipt(result),
    trace
  });
}

function publicRecallDelivery(result: RecallResult): unknown {
  return Object.freeze({
    candidates: result.candidates,
    synthesis: result.synthesis,
    active_constraints: result.active_constraints,
    active_constraints_count: result.active_constraints_count,
    total_scanned: result.total_scanned,
    coarse_filter_count: result.coarse_filter_count,
    fine_assessment_count: result.fine_assessment_count,
    degradation_reason: result.degradation_reason,
    working_projection: result.working_projection,
    delivery_path: result.delivery_path,
    ranking_authority: result.ranking_authority,
    capture_identity: result.capture_identity,
    capture_execution: result.capture_execution,
    diagnostics: omitLatency(result.diagnostics)
  });
}

function publicRecallReceipt(result: RecallResult): unknown {
  return Object.freeze({
    delivery_path: result.delivery_path,
    ranking_authority: result.ranking_authority,
    capture_identity: result.capture_identity,
    capture_execution: result.capture_execution,
    capture_receipt: result.diagnostics?.capture_receipt ?? null
  });
}

function omitLatency(diagnostics: RecallResult["diagnostics"]): unknown {
  if (diagnostics === undefined) return null;
  const {
    phase_latency_ms: _phase,
    evidence_embedding_latency_ms: _evidence,
    ...rest
  } = diagnostics;
  return rest;
}

function createObservableEmbeddingPorts(memory: MemoryEntry) {
  const stored = createEmbeddingRecord({
    object_id: memory.object_id,
    content_hash: hashMemoryContent(memory.content),
    embedding: new Float32Array([1, 0])
  });
  const providerEmbedTexts: ProviderEmbedCall[] = [];
  const repoReads: RepoRead[] = [];
  return {
    embedTexts: async (texts: readonly string[], options: { readonly timeoutMs: number }) => {
      providerEmbedTexts.push(Object.freeze({
        texts: Object.freeze([...texts]),
        timeoutMs: options.timeoutMs
      }));
      return texts.map(() => new Float32Array([1, 0]));
    },
    listByObjectIds: async (workspaceId: string, objectIds: readonly string[]) => {
      repoReads.push(Object.freeze({
        method: "listByObjectIds" as const,
        workspaceId,
        objectIds: Object.freeze([...objectIds])
      }));
      return objectIds.includes(memory.object_id) ? [stored] : [];
    },
    listByWorkspace: async (
      workspaceId: string,
      options?: unknown
    ) => {
      repoReads.push(Object.freeze({
        method: "listByWorkspace" as const,
        workspaceId,
        options: options ?? null
      }));
      return [stored];
    },
    drain(): PortTrace {
      const trace = Object.freeze({
        provider_embed_texts: Object.freeze(providerEmbedTexts.splice(0)),
        repo_reads: Object.freeze(repoReads.splice(0)),
        repo_writes: Object.freeze([])
      });
      return trace;
    }
  };
}
