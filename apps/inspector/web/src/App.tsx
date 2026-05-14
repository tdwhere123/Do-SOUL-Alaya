import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import { getInspectorToken, setInspectorToken, setUnauthorizedHandler, setWorkspaceId } from "./api";

import ConfigPage from "./pages/Config";
import GraphPage from "./pages/Graph";
import OverviewPage from "./pages/Overview";
import ProposalsPage from "./pages/Proposals";
import StatusPage from "./pages/Status";

import Layout from "./components/Layout";
import SessionExpired from "./components/SessionExpired";
import { ToastProvider } from "./components/Toast";
import { LocaleProvider } from "./i18n/Locale";

export function AppContent() {
  const [searchParams] = useSearchParams();
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

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
    <Routes>
      <Route element={<Layout />}>
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/config" element={<ConfigPage />} />
        <Route path="/graph" element={<GraphPage />} />
        <Route path="/proposals" element={<ProposalsPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/" element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
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
