import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { useToasts } from '../components/Toast';
import { Activity, Server, Zap, Shield } from 'lucide-react';
import { clsx } from 'clsx';

export default function StatusPage() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToasts();

  useEffect(() => {
    const fetchData = async () => {
      try {
        const result = await apiFetch<any>('/status');
        setStatus(result.data);
      } catch (err: any) {
        showToast({ message: `Failed to fetch status: ${err.message}`, type: 'error' });
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !status) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#FDF6E3]">
        <p className="font-mono text-xs uppercase animate-pulse">Querying Engine Status...</p>
      </div>
    );
  }

  const StepItem = ({ step, index }: { step: string, index: number }) => (
    <div className="flex items-start gap-4 py-3 border-b border-beige-200 last:border-0 group">
      <span className="text-[10px] font-mono text-ink-700/30 mt-1">{String(index + 1).padStart(2, '0')}</span>
      <div className="flex-1">
        <p className="text-sm font-mono text-ink-700">{step}</p>
        <div className="flex items-center gap-2 mt-1">
          <div className="w-1.5 h-1.5 rounded-full bg-morandi-green" />
          <span className="text-[9px] uppercase tracking-widest text-ink-700/40">Verified</span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto w-full p-8 font-mono">
      <header className="mb-12 flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold text-ink-600 mb-2">System Status</h1>
          <p className="text-ink-700/60 text-sm">Real-time telemetry from the Alaya daemon and core services.</p>
        </div>
        <div className="text-right">
          <div className="flex items-center gap-2 justify-end text-morandi-green">
            <div className="w-2 h-2 rounded-full bg-current animate-pulse" />
            <span className="text-xs font-bold uppercase tracking-wider">Operational</span>
          </div>
          <p className="text-[10px] text-ink-700/40 mt-1">LAST_CHECK: {status?.checked_at ? new Date(status.checked_at).toLocaleTimeString() : 'N/A'}</p>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <div className="p-6 bg-beige-50 border border-beige-200 rounded-lg">
          <div className="flex items-center gap-3 mb-4 text-ink-700/40">
            <Zap className="w-4 h-4" />
            <span className="text-[10px] uppercase tracking-widest font-bold">Daemon Ready</span>
          </div>
          <div className="text-2xl font-bold text-ink-600">
            {status?.daemon?.ready ? 'ACTIVE' : 'INITIALIZING'}
          </div>
        </div>

        <div className="p-6 bg-beige-50 border border-beige-200 rounded-lg">
          <div className="flex items-center gap-3 mb-4 text-ink-700/40">
            <Activity className="w-4 h-4" />
            <span className="text-[10px] uppercase tracking-widest font-bold">MCP Tools</span>
          </div>
          <div className="text-2xl font-bold text-ink-600">
            {status?.mcp?.enrolled_tools || 0}
          </div>
        </div>

        <div className="p-6 bg-beige-50 border border-beige-200 rounded-lg">
          <div className="flex items-center gap-3 mb-4 text-ink-700/40">
            <Shield className="w-4 h-4" />
            <span className="text-[10px] uppercase tracking-widest font-bold">Coding Engine</span>
          </div>
          <div className="text-2xl font-bold text-ink-600">
            {status?.daemon?.principal_coding_engine_available ? 'AVAIL' : 'UNAVAIL'}
          </div>
        </div>
      </div>

      <div className="space-y-12">
        <section>
          <div className="flex items-center gap-3 mb-6 border-b border-ink-600/10 pb-2">
            <Server className="w-5 h-5 text-ink-600" />
            <h3 className="text-sm font-bold text-ink-600 uppercase tracking-widest">Startup Log</h3>
          </div>
          <div className="bg-beige-50/50 rounded-lg border border-beige-200 px-6">
            {status?.daemon?.startup_steps?.map((step: string, i: number) => (
              <StepItem key={i} step={step} index={i} />
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-center gap-3 mb-6 border-b border-ink-600/10 pb-2">
            <Activity className="w-5 h-5 text-ink-600" />
            <h3 className="text-sm font-bold text-ink-600 uppercase tracking-widest">Active MCP Servers</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {status?.mcp?.allowed_servers?.map((server: string) => (
              <span key={server} className="px-3 py-1 bg-beige-200 text-ink-700 text-[10px] font-bold rounded-full border border-beige-300 uppercase tracking-wider">
                {server}
              </span>
            ))}
            {!status?.mcp?.allowed_servers?.length && (
              <p className="text-ink-700/40 text-xs italic">No external MCP servers registered.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
