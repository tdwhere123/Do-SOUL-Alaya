import { Cpu, Globe, KeyRound, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import EmbeddingSupplementForm from "../components/embedding-supplement-form";
import GardenComputeForm from "../components/garden-compute-form";
import ManifestationBudgetForm from "../components/manifestation-budget-form";
import { ConfigSection, type SectionMeta } from "./config-section";
import type { ConfigPageState } from "./config-page-state";
import type { DictKey } from "../i18n/dict";
import { useI18n } from "../i18n/locale";

type Translate = (key: DictKey, params?: Record<string, string | number>) => string;
const RESTART_COMMAND = "alaya stop && alaya start";

export const CONFIG_SECTIONS: ReadonlyArray<SectionMeta> = [
  { key: "soul", title: "Soul Runtime", titleKey: "config:section.soul", icon: <Cpu className="h-6 w-6" /> },
  { key: "strategy", title: "Strategy & Guardrails", titleKey: "config:section.strategy", icon: <ShieldCheck className="h-6 w-6" /> },
  { key: "environment", title: "Environment", titleKey: "config:section.environment", icon: <Globe className="h-6 w-6" /> }
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
  const { t } = useI18n();
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-8 font-mono">
        {props.state.restartPending ? <RestartPendingBanner onDismiss={props.state.dismissRestart} t={t} /> : null}
        <ConfigHeader t={t} />
        <GenericConfigSections workspaceId={props.workspaceId} state={props.state} />
        <SpecializedConfigPanels workspaceId={props.workspaceId} onRequiresRestart={props.state.handleRestartRequired} t={t} />
        <DiagnosticPanel dirtyCount={props.state.dirtySections.size} workspaceId={props.workspaceId} t={t} />
      </div>
    </div>
  );
}

function RestartPendingBanner(props: { readonly onDismiss: () => void; readonly t: Translate }) {
  return (
    <div role="alert" className="mb-8 flex items-start justify-between gap-4 rounded border border-beige-300 bg-beige-200/60 px-4 py-3 text-xs text-ink-700">
      <div className="flex-1">
        <p className="mb-1 font-bold uppercase tracking-widest">{props.t("config:restart.title")}</p>
        <p className="text-ink-700/80">{props.t("config:restart.body")}</p>
        <code className="mt-2 inline-block rounded bg-beige-100 px-2 py-1 text-[10px]">{RESTART_COMMAND}</code>
      </div>
      <RestartBannerActions onDismiss={props.onDismiss} t={props.t} />
    </div>
  );
}

function RestartBannerActions(props: { readonly onDismiss: () => void; readonly t: Translate }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => navigator.clipboard.writeText(RESTART_COMMAND)} className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-600 transition-colors hover:bg-beige-200 rounded">
        {props.t("config:restart.copyCommand")}
      </button>
      <button type="button" onClick={props.onDismiss} className="text-ink-700/40 hover:text-ink-700" aria-label={props.t("config:restart.dismissAria")}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function ConfigHeader(props: { readonly t: Translate }) {
  return (
    <header className="mb-12">
      <h1 className="mb-2 text-3xl font-bold text-ink-600">{props.t("config:header.title")}</h1>
      <p className="text-sm text-ink-700/60">{props.t("config:header.subtitle")}</p>
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
  readonly t: Translate;
}) {
  return (
    <>
      <ConfigFormPanel icon={<KeyRound className="h-6 w-6" />} title={props.t("config:panel.embeddingSupplement")}>
        <EmbeddingSupplementForm onRequiresRestart={props.onRequiresRestart} workspaceId={props.workspaceId} />
      </ConfigFormPanel>
      <ConfigFormPanel icon={<KeyRound className="h-6 w-6" />} title={props.t("config:panel.gardenCompute")}>
        <GardenComputeForm onRequiresRestart={props.onRequiresRestart} workspaceId={props.workspaceId} />
      </ConfigFormPanel>
      <ConfigFormPanel icon={<SlidersHorizontal className="h-6 w-6" />} title={props.t("config:panel.manifestationBudget")}>
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

function DiagnosticPanel(props: { readonly dirtyCount: number; readonly workspaceId: string; readonly t: Translate }) {
  return (
    <div className="mt-12 rounded-lg border border-beige-200 bg-beige-200/30 p-6">
      <h3 className="mb-4 text-sm font-bold uppercase tracking-widest text-ink-600">{props.t("config:diagnostic.heading")}</h3>
      <div className="space-y-1 text-[10px] text-ink-700/60">
        <p>WORKSPACE_ID: {props.workspaceId}</p>
        <p>SCHEMA_VERSION: v0.1.0-alpha.4</p>
        <p>DAEMON_TARGET: LOCAL_HOST_PROXY</p>
        <p>DIRTY_SECTIONS: {props.dirtyCount}</p>
      </div>
    </div>
  );
}
