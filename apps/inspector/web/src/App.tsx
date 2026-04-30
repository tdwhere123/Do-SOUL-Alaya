import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import { setInspectorToken } from './api';

// Pages (will be implemented later)
import ConfigPage from './pages/Config';
import GraphPage from './pages/Graph';
import StatusPage from './pages/Status';

// Layout component
import Layout from './components/Layout';

function AppContent() {
  const [searchParams] = useSearchParams();
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get('token');
    if (token) {
      setInspectorToken(token);
      setReady(true);
    } else {
      setAuthError('No token found in URL. Please run `alaya inspect` to open this tool.');
    }
  }, [searchParams]);

  if (authError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#FDF6E3] p-8 text-center">
        <h1 className="text-2xl font-bold text-[#586E75] mb-4">Authentication Required</h1>
        <p className="text-[#657B83] max-w-md">{authError}</p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#FDF6E3]">
        <p className="text-[#586E75]">Initializing Inspector...</p>
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/config" element={<ConfigPage />} />
        <Route path="/graph" element={<GraphPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/" element={<Navigate to="/config" replace />} />
      </Route>
    </Routes>
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
