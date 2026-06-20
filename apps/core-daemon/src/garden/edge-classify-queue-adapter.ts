import { createHash } from "node:crypto";
import type { EdgeClassifyQueuePort } from "@do-soul/alaya-core";
import {
  EdgeClassifyTaskPayloadSchema,
  GardenRole,
  GardenTaskKind,
  GardenTier
} from "@do-soul/alaya-protocol";
import type { GardenTaskEnqueueInput } from "@do-soul/alaya-storage";

/**
 * @anchor edge-classify-queue-adapter
 *
 * Implements the core EdgeClassifyQueuePort by enqueuing an EDGE_CLASSIFY
 * garden task into the shared garden_tasks queue. The deterministic
 * (workspace, source, neighbor) task id lets SQLite's primary-key constraint
 * act as the duplicate guard, so re-enriching the same pair collapses to one
 * task instead of fanning out duplicate host-worker work.
 *
 * invariant: this adapter only ENQUEUES — it never renders the verdict.
 * The attached CLI agent (the compute) claims and completes the task via MCP
 * garden.complete_task(edge_verdict); the daemon then refines the existing
 * heuristic path. Enqueue failures propagate to the caller, which (in
 * EdgeAutoProducerService.deferEdgeClassify) swallows them as best-effort —
 * the inline heuristic edge already stands.
 * see also: packages/core/src/path-graph/edge-auto-producer-service.ts deferEdgeClassify.
 * see also: apps/core-daemon/src/mcp-memory/tool-handler.ts completeEdgeClassifyTask.
 */
export interface EdgeClassifyQueueRepoPort {
  enqueue(input: GardenTaskEnqueueInput): { readonly task_id: string };
  findById(taskId: string): { readonly id: string } | null;
}

const EDGE_CLASSIFY_PRIORITY = 30;
const EDGE_CLASSIFY_CONTENT_MAX_CHARS = 4000;

export function createEdgeClassifyQueueAdapter(deps: {
  readonly gardenTaskRepo: EdgeClassifyQueueRepoPort;
  readonly now?: () => string;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}): EdgeClassifyQueuePort {
  const now = deps.now ?? (() => new Date().toISOString());
  return {
    async enqueueEdgeClassify(input): Promise<void> {
      const taskId = buildEdgeClassifyTaskId(
        input.workspaceId,
        input.source.object_id,
        input.neighbor.object_id
      );
      if (deps.gardenTaskRepo.findById(taskId) !== null) {
        return;
      }
      await enqueueEdgeClassifyTask(deps.gardenTaskRepo, input, taskId, now());
    }
  };
}

async function enqueueEdgeClassifyTask(
  gardenTaskRepo: EdgeClassifyQueueRepoPort,
  input: Parameters<EdgeClassifyQueuePort["enqueueEdgeClassify"]>[0],
  taskId: string,
  createdAt: string
): Promise<void> {
  const payload = buildEdgeClassifyTaskPayload(input, taskId, createdAt);
  try {
    gardenTaskRepo.enqueue({
      id: taskId,
      workspace_id: input.workspaceId,
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.EDGE_CLASSIFY,
      payload,
      created_at: createdAt
    });
  } catch (error) {
    if (isDuplicateInsert(error)) {
      return;
    }
    throw error;
  }
}

function buildEdgeClassifyTaskPayload(
  input: Parameters<EdgeClassifyQueuePort["enqueueEdgeClassify"]>[0],
  taskId: string,
  createdAt: string
) {
  return EdgeClassifyTaskPayloadSchema.parse({
    task_id: taskId,
    task_kind: GardenTaskKind.EDGE_CLASSIFY,
    required_tier: GardenTier.TIER_2,
    run_id: input.runId,
    workspace_id: input.workspaceId,
    priority: EDGE_CLASSIFY_PRIORITY,
    created_at: createdAt,
    dimension: input.dimension,
    scope_class: input.scopeClass,
    source_memory: buildEdgeClassifyMemoryPayload(input.source),
    neighbor_memory: buildEdgeClassifyMemoryPayload(input.neighbor),
    source_signal_id: input.sourceSignalId
  });
}

function buildEdgeClassifyMemoryPayload(memory: {
  readonly object_id: string;
  readonly content: string;
  readonly domainTags: readonly string[];
}) {
  return {
    object_id: memory.object_id,
    content: memory.content.slice(0, EDGE_CLASSIFY_CONTENT_MAX_CHARS),
    domain_tags: [...memory.domainTags]
  };
}

// Dedup key is (workspace_id, source_object_id, neighbor_object_id): a
// deterministic id so the garden_tasks primary key dedupes a re-enriched pair.
export function buildEdgeClassifyTaskId(
  workspaceId: string,
  sourceObjectId: string,
  neighborObjectId: string
): string {
  const digest = createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(sourceObjectId)
    .update("\0")
    .update(neighborObjectId)
    .digest("hex")
    .slice(0, 32);
  return `edge_classify_${digest}`;
}

function isDuplicateInsert(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE|PRIMARY KEY|constraint/i.test(message);
}
