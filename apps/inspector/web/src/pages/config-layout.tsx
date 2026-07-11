import { Cpu, Globe, KeyRound, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import EmbeddingSupplementForm from "../components/embedding-supplement-form";
import GardenComputeForm from "../components/garden-compute-form";
import ManifestationBudgetForm from "../components/manifestation-budget-form";
import { ConfigSection, type SectionMeta } from "./config-section";
import type { ConfigPageState } from "./config-page-state";
import type { DictKey } from "../i18n/dict";

type Translate = (key: DictKey, params?: Record<string, string | number>) => string;

export const CONFIG_SECTIONS: ReadonlyArray<SectionMeta> = [
  { key: "soul", title: "Soul Runtime", icon: <Cpu className="h-6 w-6" /> },
  { key: "strategy", title: "Strategy & Guardrails", icon: <ShieldCheck className="h-6 w-6" /> },
  { key: "environment", title: "Environment", icon: <Globe className="h-6 w-6" /> }
];

export function ConfigNoWorkspace(props: { readonly t: Translate }) {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div role="alert" data-testid="config-no-workspace" className="mx-auto w-full max-w-4xl p-8 font-mono text-sm text-ink-700">
        <h1 className="mb-3 text-2xl font-bold uppercase tracking-widest text-ink-600">
          {props.t("common:noWorkspace")}
        </h1>
      </div>
    </div>
  );
}

export function ConfigPageShell(props: {
  readonly workspaceId: string;
  readonly state: ConfigPageState;
}) {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-8 font-mono">
        {props.state.restartPending ? <RestartPendingBanner onDismiss={props.state.dismissRestart} /> : null}
        <ConfigHeader />
        <GenericConfigSections workspaceId={props.workspaceId} state={props.state} />
        <SpecializedConfigPanels workspaceId={props.workspaceId} onRequiresRestart={props.state.handleRestartRequired} />
        <DiagnosticPanel dirtyCount={props.state.dirtySections.size} workspaceId={props.workspaceId} />
      </div>
    </div>
  );
}

function RestartPendingBanner(props: { readonly onDismiss: () => void }) {
  return (
    <div role="alert" className="mb-8 flex items-start justify-between gap-4 rounded border border-beige-300 bg-beige-200/60 px-4 py-3 text-xs text-ink-700">
      <div className="flex-1">
        <p className="mb-1 font-bold uppercase tracking-widest">Restart Daemon Pending</p>
        <p className="text-ink-700/80">Apply changes by restarting the daemon. The Inspector cannot do this for you.</p>
        <code className="mt-2 inline-block rounded bg-beige-100 px-2 py-1 text-[10px]">alaya stop && alaya start</code>
      </div>
      <RestartBannerActions onDismiss={props.onDismiss} />
    </div>
  );
}

function RestartBannerActions(props: { readonly onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => navigator.clipboard.writeText("alaya stop && alaya start")} className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-600 transition-colors hover:bg-beige-200 rounded">
        Copy Command
      </button>
      <button type="button" onClick={props.onDismiss} className="text-ink-700/40 hover:text-ink-700" aria-label="Dismiss restart banner">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function ConfigHeader() {
  return (
    <header className="mb-12">
      <h1 className="mb-2 text-3xl font-bold text-ink-600">System Configuration</h1>
      <p className="text-sm text-ink-700/60">
        Fine-tune the Alaya engine behavior and strategy parameters.
      </p>
    </header>
  );
}

function GenericConfigSections(props: {
  readonly workspaceId: string;
  readonly state: ConfigPageState;
}) {
  return (
    <>
      {CONFIG_SECTIONS.map((section) => (
        <ConfigSection
          key={section.key}
          meta={section}
          workspaceId={props.workspaceId}
          onDirtyChange={props.state.handleSectionDirtyChange}
          onRequiresRestart={props.state.handleRestartRequired}
        />
      ))}
    </>
  );
}

function SpecializedConfigPanels(props: {
  readonly workspaceId: string;
  readonly onRequiresRestart: () => void;
}) {
  return (
    <>
      <ConfigFormPanel icon={<KeyRound className="h-6 w-6" />} title="Embedding Supplement">
        <EmbeddingSupplementForm onRequiresRestart={props.onRequiresRestart} workspaceId={props.workspaceId} />
      </ConfigFormPanel>
      <ConfigFormPanel icon={<KeyRound className="h-6 w-6" />} title="Garden Compute">
        <GardenComputeForm onRequiresRestart={props.onRequiresRestart} workspaceId={props.workspaceId} />
      </ConfigFormPanel>
      <ConfigFormPanel icon={<SlidersHorizontal className="h-6 w-6" />} title="Manifestation Budget">
        <ManifestationBudgetForm workspaceId={props.workspaceId} />
      </ConfigFormPanel>
    </>
  );
}

function ConfigFormPanel(props: {
  readonly children: ReactNode;
  readonly icon: ReactNode;
  readonly title: string;
}) {
  return (
    <div className="mb-12 border-b border-beige-200 pb-8">
      <div className="mb-6 flex items-center gap-3">
        <div className="text-ink-600">{props.icon}</div>
        <h2 className="text-xl font-bold uppercase tracking-wider text-ink-600">{props.title}</h2>
      </div>
      {props.children}
    </div>
  );
}

function DiagnosticPanel(props: { readonly dirtyCount: number; readonly workspaceId: string }) {
  return (
    <div className="mt-12 rounded-lg border border-beige-200 bg-beige-200/30 p-6">
      <h3 className="mb-4 text-sm font-bold uppercase tracking-widest text-ink-600">Diagnostic Information</h3>
      <div className="space-y-1 text-[10px] text-ink-700/60">
        <p>WORKSPACE_ID: {props.workspaceId}</p>
        <p>SCHEMA_VERSION: v0.1.0-alpha.4</p>
        <p>DAEMON_TARGET: LOCAL_HOST_PROXY</p>
        <p>DIRTY_SECTIONS: {props.dirtyCount}</p>
      </div>
    </div>
  );
}
