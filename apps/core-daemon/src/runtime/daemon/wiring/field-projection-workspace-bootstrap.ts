import { CONDITIONAL_FIELD_GENERATION_OPERATOR_ID, type Workspace } from "@do-soul/alaya-protocol";
import { generationFromRow } from "@do-soul/alaya-storage";
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
    const active = fieldComposition.fieldRepos.generations.readActive(workspace.workspace_id);
    if (active !== null && generationFromRow(active).producer === CONDITIONAL_FIELD_GENERATION_OPERATOR_ID) {
      return;
    }
    fieldComposition.projectionLifecycle.rebuild(workspace.workspace_id, now());
  };
}
