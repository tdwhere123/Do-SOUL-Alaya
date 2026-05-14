import { Activity, RotateCcw, Server, Shield, Zap } from "lucide-react";
import type { AlayaStatus } from "@do-soul/alaya-protocol";
import { useDaemonHealth } from "../hooks/useDaemonHealth";

export default function StatusPage() {
  const { state, indicator, refresh, refreshing } = useDaemonHealth();
  const loading = state.kind === "loading";
  const status: AlayaStatus | null =
    state.kind === "ok"
      ? state.status
      : state.kind === "degraded"
        ? state.lastStatus
        : null;
  const schemaMismatch = state.kind === "schema_error";
  const degraded = state.kind === "degraded" ? state.message : null;
  const handleManualRefresh = () => void refresh();

  if (loading && !status) {
    return (
      <div className="flex-1 flex items-center justify-center bg-beige-100">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-ink-600/20 border-t-ink-600 rounded-full animate-spin" />
          <p className="text-ink-600 font-mono text-xs uppercase tracking-widest">
            Querying Engine Status...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto"><div className="max-w-4xl mx-auto w-full p-8 font-mono">
      {degraded ? (
        <div
          role="alert"
          className="mb-6 px-4 py-2 bg-beige-200/50 border border-beige-300 rounded text-xs text-ink-700/80 font-mono flex items-center justify-between"
        >
          <span>STATUS_FEED_DEGRADED · backing off to 30s · last: {degraded}</span>
        </div>
      ) : null}

      <header className="mb-12 flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold text-ink-600 mb-2">System Status</h1>
          <p className="text-ink-700/60 text-sm">
            Real-time telemetry from the Alaya daemon and core services.
          </p>
        </div>
        <div className="text-right flex flex-col items-end gap-2">
          <div
            className={`flex items-center gap-2 justify-end ${indicator.colorClass}`}
            data-testid="health-indicator"
          >
            <div className="w-2 h-2 rounded-full bg-current animate-pulse" />
            <span className="text-xs font-bold uppercase tracking-wider">
              {indicator.label}
            </span>
          </div>
          <button
            onClick={handleManualRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 px-3 py-1 text-[10px] uppercase tracking-widest text-ink-700/60 hover:text-ink-700 disabled:opacity-50 transition-colors"
            aria-label="Refresh status now"
          >
            <RotateCcw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <p className="text-[10px] text-ink-700/40">
            LAST_CHECK:{" "}
            {status?.checked_at ? new Date(status.checked_at).toLocaleTimeString() : "N/A"}
          </p>
        </div>
      </header>

      {schemaMismatch ? (
        <div className="p-6 bg-beige-50 border border-beige-200 rounded-lg text-sm text-ink-700/80">
          Status payload schema mismatch (v0.1 contract). Inspector cannot render the
          telemetry block until the daemon and protocol package agree on{" "}
          <code>AlayaStatusSchema</code>.
        </div>
      ) : status ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
            <StatCard
              icon={<Zap className="w-4 h-4" />}
              label="Daemon Ready"
              value={status.daemon.ready ? "ACTIVE" : "INITIALIZING"}
            />
            <StatCard
              icon={<Activity className="w-4 h-4" />}
              label="MCP Tools"
              value={String(status.mcp.enrolled_tools)}
            />
            <StatCard
              icon={<Shield className="w-4 h-4" />}
              label="Coding Engine"
              value={status.daemon.principal_coding_engine_available ? "AVAIL" : "UNAVAIL"}
            />
          </div>

          <div className="space-y-12">
            <section>
              <div className="flex items-center gap-3 mb-6 border-b border-ink-600/10 pb-2">
                <Server className="w-5 h-5 text-ink-600" />
                <h3 className="text-sm font-bold text-ink-600 uppercase tracking-widest">
                  Startup Log
                </h3>
              </div>
              <div className="bg-beige-50/50 rounded-lg border border-beige-200 px-6">
                {status.daemon.startup_steps.map((step, i) => (
                  <StepItem key={`${i}-${step}`} step={step} index={i} />
                ))}
                {status.daemon.startup_steps.length === 0 ? (
                  <p className="py-3 text-ink-700/40 text-xs italic">
                    No startup steps recorded yet.
                  </p>
                ) : null}
              </div>
            </section>

            <section>
              <div className="flex items-center gap-3 mb-6 border-b border-ink-600/10 pb-2">
                <Activity className="w-5 h-5 text-ink-600" />
                <h3 className="text-sm font-bold text-ink-600 uppercase tracking-widest">
                  Active MCP Servers
                </h3>
              </div>
              <div className="flex flex-wrap gap-2">
                {status.mcp.allowed_servers.map((server) => (
                  <span
                    key={server}
                    className="px-3 py-1 bg-beige-200 text-ink-700 text-[10px] font-bold rounded-full border border-beige-300 uppercase tracking-wider"
                  >
                    {server}
                  </span>
                ))}
                {status.mcp.allowed_servers.length === 0 ? (
                  <p className="text-ink-700/40 text-xs italic">
                    No external MCP servers registered.
                  </p>
                ) : null}
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="p-6 bg-beige-50 border border-beige-200 rounded-lg">
      <div className="flex items-center gap-3 mb-4 text-ink-700/40">
        {icon}
        <span className="text-[10px] uppercase tracking-widest font-bold">{label}</span>
      </div>
      <div className="text-2xl font-bold text-ink-600">{value}</div>
    </div>
  );
}

function StepItem({ step, index }: { step: string; index: number }) {
  return (
    <div className="flex items-start gap-4 py-3 border-b border-beige-200 last:border-0 group">
      <span className="text-[10px] font-mono text-ink-700/30 mt-1">
        {String(index + 1).padStart(2, "0")}
      </span>
      <div className="flex-1">
        <p className="text-sm font-mono text-ink-700">{step}</p>
        <div className="flex items-center gap-2 mt-1">
          <div className="w-1.5 h-1.5 rounded-full bg-morandi-green" />
          <span className="text-[9px] uppercase tracking-widest text-ink-700/40">
            Verified
          </span>
        </div>
      </div>
    </div>
  );
}
