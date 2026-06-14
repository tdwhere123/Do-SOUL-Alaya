import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useSearchParams } from "react-router-dom";
import {
  getInspectorToken,
  getWorkspaceId,
  setInspectorToken,
  setUnauthorizedHandler,
  setWorkspaceId
} from "../api";

import BenchTrendPage from "../pages/BenchTrend";
import GovernancePage from "../pages/Governance";
import MemoryBrowserPage from "../pages/MemoryBrowser";
import OverviewPage from "../pages/Overview";
import RecallPage from "../pages/Recall";
import SystemPage from "../pages/System";

import CommandPalette, { useCommandPaletteHotkey } from "../components/CommandPalette";
import Layout from "../components/Layout";
import NoWorkspaceAlert from "../components/NoWorkspaceAlert";
import SessionExpired from "../components/SessionExpired";
import { ToastProvider } from "../components/Toast";
import { LocaleProvider } from "../i18n/Locale";

const GraphPage = lazy(() => import("../pages/Graph"));

export function AppContent() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useCommandPaletteHotkey(paletteOpen, () => setPaletteOpen((prev) => !prev));

  useEffect(() => {
    const launchParams = readLaunchParams(searchParams, location.hash);

    if (launchParams.token) {
      setInspectorToken(launchParams.token);
      setWorkspaceId(launchParams.workspaceId?.trim().length ? launchParams.workspaceId : null);
      clearTokenFragment();
      setAuthError(null);
      setReady(true);
    } else if (getInspectorToken()) {
      setAuthError(null);
      setReady(true);
    } else {
      setAuthError(
        "No token found in URL. Please run `alaya inspect` to open this tool."
      );
    }

    setUnauthorizedHandler(() => setSessionExpired(true));
    return () => setUnauthorizedHandler(null);
  }, [location.hash, searchParams]);

  if (sessionExpired) {
    return <SessionExpired />;
  }

  if (authError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-beige-100 p-8 text-center">
        <h1 className="text-2xl font-bold text-ink-600 mb-4 font-mono uppercase tracking-widest">
          Authentication Required
        </h1>
        <p className="text-ink-700 max-w-md font-mono text-sm leading-relaxed">
          {authError}
        </p>
        <div className="mt-8 pt-8 border-t border-beige-300 w-full max-w-xs">
          <code className="text-xs text-ink-500">ERROR_CODE: AUTH_MISSING_TOKEN</code>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-beige-100">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-2 border-ink-600/20 border-t-ink-600 rounded-full animate-spin" />
          <p className="text-ink-600 font-mono text-xs uppercase tracking-widest">
            Loading Inspector Surface...
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          {/* Five top-level nav surfaces. */}
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/governance" element={<GovernancePage />} />
          <Route path="/memory-browser" element={<MemoryBrowserPage />} />
          <Route
            path="/graph"
            element={
              <WorkspaceRequiredRoute testId="graph-no-workspace">
                <Suspense fallback={<RouteLoadingFallback label="Loading graph surface..." />}>
                  <GraphPage />
                </Suspense>
              </WorkspaceRequiredRoute>
            }
          />
          <Route path="/system" element={<SystemPage />} />
          {/* Demoted deep links (reachable via cards / command palette). */}
          <Route path="/recall" element={<RecallPage />} />
          <Route path="/bench-trend" element={<BenchTrendPage />} />
          {/* Legacy paths fold into the merged surfaces, preserving any
              incoming query string (e.g. Graph's ?highlight=). */}
          <Route
            path="/proposals"
            element={<LegacyRedirect to="/governance" tab="proposals" />}
          />
          <Route
            path="/health-inbox"
            element={<LegacyRedirect to="/governance" tab="health-inbox" />}
          />
          <Route path="/status" element={<LegacyRedirect to="/system" tab="status" />} />
          <Route path="/config" element={<LegacyRedirect to="/system" tab="config" />} />
          <Route path="/" element={<Navigate to="/overview" replace />} />
        </Route>
      </Routes>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

function readLaunchParams(searchParams: URLSearchParams, hash: string): {
  readonly token: string | null;
  readonly workspaceId: string | null;
} {
  const hashParams = new URLSearchParams(hash.replace(/^#/u, ""));
  return {
    token: hashParams.get("token"),
    workspaceId: searchParams.get("workspaceId") ?? hashParams.get("workspaceId")
  };
}

function clearTokenFragment(): void {
  if (!window.location.hash.includes("token=")) {
    return;
  }

  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}`
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
  if (getWorkspaceId() === null) {
    return <NoWorkspaceAlert testId={testId} />;
  }
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

function App() {
  return (
    <BrowserRouter>
      <LocaleProvider>
        <ToastProvider>
          <AppContent />
        </ToastProvider>
      </LocaleProvider>
    </BrowserRouter>
  );
}

export default App;
