import { Activity, RotateCcw, Server, Shield, Zap } from "lucide-react";
import type { ReactNode } from "react";
import type { AlayaStatus } from "@do-soul/alaya-protocol";
import type { useDaemonHealth } from "../hooks/useDaemonHealth";
import type { DictKey } from "../i18n/dict";

type Translate = (key: DictKey, params?: Record<string, string | number>) => string;

export function StatusLoadingView() {
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

export function StatusPageShell(props: {
  readonly degraded: string | null;
  readonly indicator: ReturnType<typeof useDaemonHealth>["indicator"];
  readonly refreshing: boolean;
  readonly schemaMismatch: boolean;
  readonly status: AlayaStatus | null;
  readonly t: Translate;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="max-w-4xl mx-auto w-full p-8 font-mono">
        {props.degraded ? <StatusDegradedAlert message={props.degraded} /> : null}
        <StatusHeader {...props} />
        <StatusBody schemaMismatch={props.schemaMismatch} status={props.status} />
      </div>
    </div>
  );
}

function StatusDegradedAlert(props: { readonly message: string }) {
  return (
    <div role="alert" className="mb-6 px-4 py-2 bg-beige-200/50 border border-beige-300 rounded text-xs text-ink-700/80 font-mono flex items-center justify-between">
      <span>STATUS_FEED_DEGRADED · backing off to 30s · last: {props.message}</span>
    </div>
  );
}

function StatusHeader(props: {
  readonly indicator: ReturnType<typeof useDaemonHealth>["indicator"];
  readonly refreshing: boolean;
  readonly status: AlayaStatus | null;
  readonly t: Translate;
  readonly onRefresh: () => void;
}) {
  return (
    <header className="mb-12 flex justify-between items-end">
      <div>
        <h1 className="text-3xl font-bold text-ink-600 mb-2">{props.t("status:title")}</h1>
        <p className="text-ink-700/60 text-sm">{props.t("status:subtitle")}</p>
      </div>
      <StatusRefreshPanel {...props} />
    </header>
  );
}

function StatusRefreshPanel(props: {
  readonly indicator: ReturnType<typeof useDaemonHealth>["indicator"];
  readonly refreshing: boolean;
  readonly status: AlayaStatus | null;
  readonly t: Translate;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="text-right flex flex-col items-end gap-2">
      <div className={`flex items-center gap-2 justify-end ${props.indicator.colorClass}`} data-testid="health-indicator">
        <div className="w-2 h-2 rounded-full bg-current animate-pulse" />
        <span className="text-xs font-bold uppercase tracking-wider">{props.indicator.label}</span>
      </div>
      <button onClick={props.onRefresh} disabled={props.refreshing} className="flex items-center gap-2 px-3 py-1 text-[10px] uppercase tracking-widest text-ink-700/60 hover:text-ink-700 disabled:opacity-50 transition-colors" aria-label={props.t("common:refresh.aria")}>
        <RotateCcw className={`w-3 h-3 ${props.refreshing ? "animate-spin" : ""}`} />
        {props.t("common:refresh")}
      </button>
      <p className="text-[10px] text-ink-700/40">LAST_CHECK: {lastCheckedLabel(props.status)}</p>
    </div>
  );
}

function StatusBody(props: {
  readonly schemaMismatch: boolean;
  readonly status: AlayaStatus | null;
}) {
  if (props.schemaMismatch) return <SchemaMismatchBlock />;
  if (props.status === null) return null;
  return (
    <>
      <StatusStatsGrid status={props.status} />
      <div className="space-y-12">
        <StartupLog steps={props.status.daemon.startup_steps} />
        <ActiveServers servers={props.status.mcp.allowed_servers} />
      </div>
    </>
  );
}

function SchemaMismatchBlock() {
  return (
    <div className="p-6 bg-beige-50 border border-beige-200 rounded-lg text-sm text-ink-700/80">
      Status payload schema mismatch (v0.1 contract). Inspector cannot render the
      telemetry block until the daemon and protocol package agree on <code>AlayaStatusSchema</code>.
    </div>
  );
}

function StatusStatsGrid(props: { readonly status: AlayaStatus }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
      <StatCard icon={<Zap className="w-4 h-4" />} label="Daemon Ready" value={props.status.daemon.ready ? "ACTIVE" : "INITIALIZING"} />
      <StatCard icon={<Activity className="w-4 h-4" />} label="MCP Tools" value={String(props.status.mcp.enrolled_tools)} />
      <StatCard icon={<Shield className="w-4 h-4" />} label="Coding Engine" value={props.status.daemon.principal_coding_engine_available ? "AVAIL" : "UNAVAIL"} />
    </div>
  );
}

function StartupLog(props: { readonly steps: readonly string[] }) {
  return (
    <section>
      <SectionTitle icon={<Server className="w-5 h-5 text-ink-600" />} title="Startup Log" />
      <div className="bg-beige-50/50 rounded-lg border border-beige-200 px-6">
        {props.steps.map((step, i) => <StepItem key={`${i}-${step}`} step={step} index={i} />)}
        {props.steps.length === 0 ? <p className="py-3 text-ink-700/40 text-xs italic">No startup steps recorded yet.</p> : null}
      </div>
    </section>
  );
}

function ActiveServers(props: { readonly servers: readonly string[] }) {
  return (
    <section>
      <SectionTitle icon={<Activity className="w-5 h-5 text-ink-600" />} title="Active MCP Servers" />
      <div className="flex flex-wrap gap-2">
        {props.servers.map((server) => <ServerPill key={server} server={server} />)}
        {props.servers.length === 0 ? <p className="text-ink-700/40 text-xs italic">No external MCP servers registered.</p> : null}
      </div>
    </section>
  );
}

function SectionTitle(props: { readonly icon: ReactNode; readonly title: string }) {
  return (
    <div className="flex items-center gap-3 mb-6 border-b border-ink-600/10 pb-2">
      {props.icon}
      <h3 className="text-sm font-bold text-ink-600 uppercase tracking-widest">{props.title}</h3>
    </div>
  );
}

function StatCard(props: { readonly icon: ReactNode; readonly label: string; readonly value: string }) {
  return (
    <div className="p-6 bg-beige-50 border border-beige-200 rounded-lg">
      <div className="flex items-center gap-3 mb-4 text-ink-700/40">
        {props.icon}
        <span className="text-[10px] uppercase tracking-widest font-bold">{props.label}</span>
      </div>
      <div className="text-2xl font-bold text-ink-600">{props.value}</div>
    </div>
  );
}

function StepItem(props: { readonly step: string; readonly index: number }) {
  return (
    <div className="flex items-start gap-4 py-3 border-b border-beige-200 last:border-0 group">
      <span className="text-[10px] font-mono text-ink-700/30 mt-1">{String(props.index + 1).padStart(2, "0")}</span>
      <div className="flex-1">
        <p className="text-sm font-mono text-ink-700">{props.step}</p>
        <div className="flex items-center gap-2 mt-1">
          <div className="w-1.5 h-1.5 rounded-full bg-morandi-green" />
          <span className="text-[9px] uppercase tracking-widest text-ink-700/40">Verified</span>
        </div>
      </div>
    </div>
  );
}

function ServerPill(props: { readonly server: string }) {
  return (
    <span className="px-3 py-1 bg-beige-200 text-ink-700 text-[10px] font-bold rounded-full border border-beige-300 uppercase tracking-wider">
      {props.server}
    </span>
  );
}

function lastCheckedLabel(status: AlayaStatus | null): string {
  return status?.checked_at ? new Date(status.checked_at).toLocaleTimeString() : "N/A";
}
