import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import { setInspectorToken, setWorkspaceId } from './api';

// Pages
import ConfigPage from './pages/Config';
import GraphPage from './pages/Graph';
import StatusPage from './pages/Status';

// Layout component
import Layout from './components/Layout';
import { useToasts } from './components/Toast';

function AppContent() {
  const [searchParams] = useSearchParams();
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const { ToastContainer } = useToasts();

  useEffect(() => {
    const token = searchParams.get('token');
    const workspaceId = searchParams.get('workspaceId');
    
    if (token) {
      setInspectorToken(token);
      if (workspaceId) {
        setWorkspaceId(workspaceId);
      }
      setReady(true);
    } else {
      setAuthError('No token found in URL. Please run `alaya inspect` to open this tool.');
    }
  }, [searchParams]);

  if (authError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#FDF6E3] p-8 text-center">
        <h1 className="text-2xl font-bold text-[#586E75] mb-4 font-mono uppercase tracking-widest">Authentication Required</h1>
        <p className="text-[#657B83] max-w-md font-mono text-sm leading-relaxed">{authError}</p>
        <div className="mt-8 pt-8 border-t border-[#D4CDB8] w-full max-w-xs">
          <code className="text-xs text-[#93A1A1]">ERROR_CODE: AUTH_MISSING_TOKEN</code>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#FDF6E3]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-2 border-[#586E75]/20 border-t-[#586E75] rounded-full animate-spin" />
          <p className="text-[#586E75] font-mono text-xs uppercase tracking-widest">Loading Inspector Surface...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/status" element={<StatusPage />} />
          <Route path="/" element={<Navigate to="/config" replace />} />
        </Route>
      </Routes>
      <ToastContainer />
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

export default App;
