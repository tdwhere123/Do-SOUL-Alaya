import { InspectorAppShell, InspectorProviders } from "./app-shell";
import { useInspectorLaunchState } from "./inspector-launch-state";

export function AppContent() {
  return <InspectorAppShell state={useInspectorLaunchState()} />;
}

export default function App() {
  return <InspectorProviders />;
}
