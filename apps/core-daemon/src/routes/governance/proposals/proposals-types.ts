import type {
  MemoryService,
  ProposalService,
  WorkspaceService
} from "@do-soul/alaya-core";
import type { McpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";

export interface ProposalRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly memoryService: Pick<MemoryService, "findByIdScoped">;
  readonly proposalService: ProposalService;
  // invariant: the Inspector loopback uses these workspace-scoped HTTP
  // wrappers around the same MCP handler that attached agents call. The
  // wrappers exist on the daemon HTTP plane (not the agent control
  // plane): they are workspace-scoped at the URL level, so the removed
  // unscoped POST /proposals/:id/review route does not re-open. Per
  // invariant §21 (Inspector loopback only) the durable
  // promotion still routes through `proposalRepo.updatePendingResolutionWithEvents`
  // via the same MCP handler attached agents use; this HTTP wrapper does
  // not own the storage-atomic path.
  //
  // Production wiring always constructs the handler in
  // `apps/core-daemon/src/index.ts`; keep this required so a future wiring
  // drop fails at compile time instead of turning into a silent route 503.
  readonly mcpMemoryToolHandler: McpMemoryToolHandler;
}
