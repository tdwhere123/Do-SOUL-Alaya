import { useEffect, useState } from 'react';
import { apiFetch, getWorkspaceId } from '../api';
import { useToasts } from '../components/Toast';
import { Save, RotateCcw, ShieldCheck, Cpu, Globe } from 'lucide-react';
import { clsx } from 'clsx';

interface ConfigSectionProps {
  title: string;
  endpoint: string;
  icon: React.ReactNode;
}

function ConfigSection({ title, endpoint, icon }: ConfigSectionProps) {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToasts();
  const workspaceId = getWorkspaceId() || 'default';

  useEffect(() => {
    const load = async () => {
      try {
        const data = await apiFetch<any>(`/config/${workspaceId}/${endpoint}`);
        setConfig(data);
      } catch (err: any) {
        showToast({ message: `Failed to load ${title}: ${err.message}`, type: 'error' });
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [workspaceId, endpoint, title]);

  const handleSave = async () => {
    try {
      setSaving(true);
      const result = await apiFetch<any>(`/config/${workspaceId}/${endpoint}`, {
        method: 'PATCH',
        body: config
      });
      showToast({ message: `${title} updated successfully.`, type: 'success' });
      
      if (result.requires_daemon_restart) {
        showToast({ 
          message: "Daemon restart required to apply changes.", 
          type: 'warning',
          duration: 0,
          action: {
            label: 'Copy Command',
            onClick: () => navigator.clipboard.writeText('alaya stop && alaya start')
          }
        });
      }
    } catch (err: any) {
      showToast({ message: `Failed to save ${title}: ${err.message}`, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (key: string, value: any) => {
    setConfig((prev: any) => ({ ...prev, [key]: value }));
  };

  if (loading) return <div className="py-4 animate-pulse text-xs text-ink-700/40 uppercase tracking-widest">Loading {title}...</div>;

  return (
    <div className="mb-12 border-b border-beige-200 pb-8 last:border-0">
      <div className="flex items-center gap-3 mb-6">
        <div className="text-ink-600">{icon}</div>
        <h2 className="text-xl font-bold text-ink-600 uppercase tracking-wider">{title}</h2>
      </div>

      <div className="space-y-4">
        {config && Object.entries(config).map(([key, value]: [string, any]) => (
          <div key={key} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2 group">
            <label className="text-xs font-mono text-ink-700/60 uppercase tracking-widest">{key.replace(/_/g, ' ')}</label>
            <div className="flex items-center gap-4">
              {typeof value === 'boolean' ? (
                <button
                  onClick={() => handleChange(key, !value)}
                  className={clsx(
                    "w-10 h-5 rounded-full relative transition-colors duration-300",
                    value ? "bg-morandi-green" : "bg-beige-300"
                  )}
                >
                  <div className={clsx(
                    "absolute top-1 w-3 h-3 rounded-full bg-beige-50 transition-transform duration-300",
                    value ? "left-6" : "left-1"
                  )} />
                </button>
              ) : (
                <input
                  type={typeof value === 'number' ? 'number' : 'text'}
                  value={value ?? ''}
                  onChange={(e) => handleChange(key, typeof value === 'number' ? Number(e.target.value) : e.target.value)}
                  className="bg-transparent border-b border-beige-300 focus:border-ink-600 outline-none text-sm text-ink-700 font-mono text-right py-1 min-w-[200px]"
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-ink-600 text-beige-50 rounded text-xs font-bold uppercase tracking-widest hover:bg-ink-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : (
            <>
              <Save className="w-4 h-4" />
              Commit Changes
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export default function ConfigPage() {
  return (
    <div className="max-w-4xl mx-auto w-full p-8 font-mono">
      <header className="mb-12">
        <h1 className="text-3xl font-bold text-ink-600 mb-2">System Configuration</h1>
        <p className="text-ink-700/60 text-sm">Fine-tune the Alaya engine behavior and strategy parameters.</p>
      </header>

      <ConfigSection 
        title="Soul Runtime" 
        endpoint="soul" 
        icon={<Cpu className="w-6 h-6" />}
      />

      <ConfigSection 
        title="Strategy & Guardrails" 
        endpoint="strategy" 
        icon={<ShieldCheck className="w-6 h-6" />}
      />

      <ConfigSection 
        title="Environment" 
        endpoint="environment" 
        icon={<Globe className="w-6 h-6" />}
      />

      <div className="mt-12 p-6 bg-beige-200/30 rounded-lg border border-beige-200">
        <h3 className="text-sm font-bold text-ink-600 uppercase tracking-widest mb-4">Diagnostic Information</h3>
        <div className="text-[10px] text-ink-700/60 space-y-1">
          <p>WORKSPACE_ID: {getWorkspaceId() || 'DEFAULT_CONTEXT'}</p>
          <p>SCHEMA_VERSION: v0.1.0-alpha.4</p>
          <p>DAEMON_TARGET: LOCAL_HOST_PROXY</p>
        </div>
      </div>
    </div>
  );
}
