import type { ConversationGardenCompileQueuePort } from "@do-soul/alaya-core";
import type { SourceAdmissionPort } from "@do-soul/alaya-protocol";
import type { GardenTaskEnqueueInput } from "@do-soul/alaya-storage";
import { enqueueConversationGardenCompileTask } from "../mcp-memory/garden-task/post-turn-extract-queue.js";

export interface ConversationCompileQueueRepoPort {
  enqueue(input: GardenTaskEnqueueInput): { readonly task_id: string };
  findById(taskId: string): { readonly id: string } | null;
}

export function createConversationGardenCompileQueue(deps: {
  readonly gardenTaskRepo: ConversationCompileQueueRepoPort;
  readonly now: () => string;
  readonly sourceAdmission?: SourceAdmissionPort;
}): ConversationGardenCompileQueuePort {
  return {
    enqueue(input) {
      return enqueueConversationGardenCompileTask(deps, input);
    }
  };
}
