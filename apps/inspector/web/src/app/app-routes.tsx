import { Suspense, lazy, type ReactNode } from "react";
import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { getWorkspaceId } from "../api";
import BenchTrendPage from "../pages/BenchTrend";
import GovernancePage from "../pages/Governance";
import MemoryBrowserPage from "../pages/MemoryBrowser";
import OverviewPage from "../pages/Overview";
import RecallPage from "../pages/Recall";
import SystemPage from "../pages/System";
import Layout from "../components/Layout";
import NoWorkspaceAlert from "../components/NoWorkspaceAlert";

const GraphPage = lazy(() => import("../pages/Graph"));

export function InspectorRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/governance" element={<GovernancePage />} />
        <Route path="/memory-browser" element={<MemoryBrowserPage />} />
        <Route path="/graph" element={<GraphRoute />} />
        <Route path="/system" element={<SystemPage />} />
        <Route path="/recall" element={<RecallPage />} />
        <Route path="/bench-trend" element={<BenchTrendPage />} />
        <Route path="/proposals" element={<LegacyRedirect to="/governance" tab="proposals" />} />
        <Route path="/health-inbox" element={<LegacyRedirect to="/governance" tab="health-inbox" />} />
        <Route path="/status" element={<LegacyRedirect to="/system" tab="status" />} />
        <Route path="/config" element={<LegacyRedirect to="/system" tab="config" />} />
        <Route path="/" element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
  );
}

function GraphRoute() {
  return (
    <WorkspaceRequiredRoute testId="graph-no-workspace">
      <Suspense fallback={<RouteLoadingFallback label="Loading graph surface..." />}>
        <GraphPage />
      </Suspense>
    </WorkspaceRequiredRoute>
  );
}

function LegacyRedirect({ to, tab }: { readonly to: string; readonly tab: string }) {
  const [searchParams] = useSearchParams();
  const next = new URLSearchParams(searchParams);
  next.set("tab", tab);
  return <Navigate to={`${to}?${next.toString()}`} replace />;
}

function WorkspaceRequiredRoute({
  children,
  testId
}: {
  readonly children: ReactNode;
  readonly testId: string;
}) {
  if (getWorkspaceId() === null) return <NoWorkspaceAlert testId={testId} />;
  return <>{children}</>;
}

function RouteLoadingFallback({ label }: { readonly label: string }) {
  return (
    <div className="flex items-center justify-center h-full min-h-[50vh] bg-beige-100">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 border-2 border-ink-600/20 border-t-ink-600 rounded-full animate-spin" />
        <p className="text-ink-600 font-mono text-xs uppercase tracking-widest">{label}</p>
      </div>
    </div>
  );
}
