import { CoreError } from "../../shared/errors.js";

export interface GovernanceRunWorkspaceLookup {
  getById(runId: string): Promise<{ readonly workspace_id: string } | null>;
}

export async function assertGovernanceRunWorkspace(
  runLookup: GovernanceRunWorkspaceLookup,
  runId: string,
  workspaceId: string
): Promise<void> {
  const run = await runLookup.getById(runId);

  if (run === null) {
    throw new CoreError("NOT_FOUND", `Run ${runId} was not found.`);
  }

  if (run.workspace_id !== workspaceId) {
    throw new CoreError("VALIDATION", "workspaceId does not match run workspace.");
  }
}
