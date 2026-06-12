import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import { getInspectorToken, setInspectorToken, setUnauthorizedHandler, setWorkspaceId } from "../api";

import BenchTrendPage from "../pages/BenchTrend";
import GovernancePage from "../pages/Governance";
import GraphPage from "../pages/Graph";
import MemoryBrowserPage from "../pages/MemoryBrowser";
import OverviewPage from "../pages/Overview";
import RecallPage from "../pages/Recall";
import SystemPage from "../pages/System";

import CommandPalette, { useCommandPaletteHotkey } from "../components/CommandPalette";
import Layout from "../components/Layout";
import SessionExpired from "../components/SessionExpired";
import { ToastProvider } from "../components/Toast";
import { LocaleProvider } from "../i18n/Locale";

export function AppContent() {
  const [searchParams] = useSearchParams();
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useCommandPaletteHotkey(paletteOpen, () => setPaletteOpen((prev) => !prev));

  useEffect(() => {
    const token = searchParams.get("token");
    const workspaceId = searchParams.get("workspaceId");

    if (token) {
      setInspectorToken(token);
      setWorkspaceId(workspaceId?.trim().length ? workspaceId : null);
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
  }, [searchParams]);

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
          <Route path="/graph" element={<GraphPage />} />
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

function LegacyRedirect({ to, tab }: { readonly to: string; readonly tab: string }) {
  const [searchParams] = useSearchParams();
  const next = new URLSearchParams(searchParams);
  next.set("tab", tab);
  return <Navigate to={`${to}?${next.toString()}`} replace />;
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
