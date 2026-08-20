import type { Workspace } from "@do-soul/alaya-protocol";
import type { DaemonFieldComposition } from "../../field/field-composition.js";

export type FieldProjectionWorkspaceBootstrap = Pick<
  DaemonFieldComposition,
  "fieldRepos" | "projectionLifecycle"
>;

export function createFieldProjectionWorkspaceBirthMutation(
  fieldComposition: FieldProjectionWorkspaceBootstrap
): (workspace: Workspace) => void {
  return (workspace) => {
    fieldComposition.projectionLifecycle.rebuild(
      workspace.workspace_id,
      workspace.created_at
    );
  };
}

export function createFieldProjectionWorkspaceEnsureMutation(
  fieldComposition: FieldProjectionWorkspaceBootstrap,
  now: () => string
): (workspace: Workspace) => void {
  return (workspace) => {
    if (fieldComposition.fieldRepos.generations.readActive(workspace.workspace_id) !== null) {
      return;
    }
    fieldComposition.projectionLifecycle.rebuild(workspace.workspace_id, now());
  };
}
