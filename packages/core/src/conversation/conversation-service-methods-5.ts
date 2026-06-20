import { requireWorkspace, type ConversationServiceMethodOwner, type Workspace } from "./conversation-service-internal.js";

export async function conversationServiceRequireWorkspace(owner: ConversationServiceMethodOwner, workspaceId: string): Promise<Workspace> {
    return requireWorkspace(owner, workspaceId);
  }
