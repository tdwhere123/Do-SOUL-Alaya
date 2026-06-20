import { getWorkspaceId } from "../api";
import NoWorkspaceAlert from "../components/NoWorkspaceAlert";
import GraphWorkspace from "./graph-page/GraphWorkspace";

/**
 * GraphPage gates the graph surface on a workspace binding before loading the
 * graph renderer and operator actions.
 */
export default function GraphPage() {
  const workspaceId = getWorkspaceId();
  if (workspaceId === null) {
    return <NoWorkspaceAlert testId="graph-no-workspace" />;
  }
  return <GraphWorkspace workspaceId={workspaceId} />;
}
