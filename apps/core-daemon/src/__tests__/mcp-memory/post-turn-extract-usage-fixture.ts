import {
  GardenRole,
  GardenTaskKind
} from "@do-soul/alaya-protocol";
import type { SqliteGardenTaskRepo } from "@do-soul/alaya-storage";

import type {
  McpMemoryToolCallContext,
  McpMemoryToolCallResult,
  McpMemoryToolHandler
} from "../../mcp-memory/tool-handler.js";
import { defaultContext } from "./post-turn-extract-task-record-fixture.js";

export async function reportUsage(
  handler: McpMemoryToolHandler,
  overrides: Partial<{
    readonly turn_index: number;
    readonly usage_state: "used" | "skipped" | "not_applicable";
    readonly used_object_ids: readonly string[];
    readonly delivered_objects: readonly {
      readonly object_id: string;
      readonly object_kind?: "memory_entry" | "evidence_capsule" | "synthesis_capsule";
      readonly usage_status: "used" | "skipped" | "not_applicable";
    }[];
    readonly last_messages: readonly {
      readonly role: string;
      readonly content_excerpt: string;
    }[];
    readonly source_observed_at: string;
    readonly context: McpMemoryToolCallContext;
  }> = {}
): Promise<McpMemoryToolCallResult> {
  const deliveredObjects =
    overrides.delivered_objects ?? [{ object_id: "memory-a", usage_status: "used" }] as const;
  const usedObjectIds = overrides.used_object_ids ??
    deliveredObjects
      .filter((object) => object.usage_status === "used")
      .map((object) => object.object_id);
  return await handler.call({
    toolName: "soul.report_context_usage",
    arguments: {
      delivery_id: "delivery-1",
      usage_state: overrides.usage_state ?? "used",
      used_object_ids: usedObjectIds,
      delivered_objects: deliveredObjects,
      turn_index: overrides.turn_index ?? 1,
      turn_digest: {
        last_messages:
          overrides.last_messages ?? [
            { role: "user", content_excerpt: "Remember that I prefer pnpm." },
            { role: "assistant", content_excerpt: "I used the project preference." }
          ]
      },
      ...(overrides.source_observed_at === undefined
        ? {}
        : { source_observed_at: overrides.source_observed_at }),
      reason: "post-turn extract test"
    },
    context: overrides.context ?? defaultContext()
  });
}

export function postTurnRows(gardenTaskRepo: SqliteGardenTaskRepo) {
  return gardenTaskRepo
    .peekPending(GardenRole.LIBRARIAN, "workspace-1", 20)
    .filter((row) => row.kind === GardenTaskKind.POST_TURN_EXTRACT);
}
