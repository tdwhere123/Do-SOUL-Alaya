import { getWorkspaceId } from "../api";
import ErrorBoundary from "../app/error-boundary";
import NoWorkspaceAlert from "../components/no-workspace-alert";
import GraphWorkspace from "./graph-page/graph-workspace";

/**
 * GraphPage gates the graph surface on a workspace binding before loading the
 * graph renderer and operator actions.
 */
export default function GraphPage() {
  const workspaceId = getWorkspaceId();
  if (workspaceId === null) {
    return <NoWorkspaceAlert testId="graph-no-workspace" />;
  }
  return (
    <ErrorBoundary>
      <GraphWorkspace workspaceId={workspaceId} />
    </ErrorBoundary>
  );
}
