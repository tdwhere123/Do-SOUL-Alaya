import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { RotateCcw, Save } from "lucide-react";
import { clsx } from "clsx";
import { apiFetch, type ApiError } from "../api";
import { useApiQuery } from "../hooks/useApiQuery";
import { useToasts } from "../components/toast";
import { ToggleSwitch } from "../components/config-form-fields";
import type { SectionKey } from "./config-page-state";
import { useI18n } from "../i18n/locale";
import type { DictKey } from "../i18n/dict";

type Translate = ReturnType<typeof useI18n>["t"];

export interface SectionMeta {
  readonly key: SectionKey;
  readonly title: string;
  readonly titleKey?: DictKey;
  readonly icon: ReactNode;
}

interface ConfigSectionProps {
  readonly meta: SectionMeta;
  readonly workspaceId: string;
  readonly onDirtyChange: (key: SectionKey, dirty: boolean) => void;
  readonly onRequiresRestart: () => void;
}

interface ConfigSectionState {
  readonly current: ConfigPayload | null;
  readonly dirty: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly handleChange: (key: string, value: unknown) => void;
  readonly handleReset: () => void;
  readonly handleSave: () => Promise<void>;
}

type ConfigPayload = Record<string, unknown>;

interface PatchResult {
  readonly success?: boolean;
  readonly requires_daemon_restart?: boolean;
  readonly data?: unknown;
}

const HIDDEN_CONFIG_KEYS = new Set(["config_version"]);

export function ConfigSection(props: ConfigSectionProps) {
  const { t } = useI18n();
  const title = props.meta.titleKey ? t(props.meta.titleKey) : props.meta.title;
  const state = useConfigSectionState(props, title, t);
  if (state.loading) return <LoadingConfigSection title={title} t={t} />;
  return <ConfigSectionView meta={props.meta} title={title} state={state} t={t} />;
}

function useConfigSectionState(props: ConfigSectionProps, title: string, t: Translate): ConfigSectionState {
  const { showToast } = useToasts();
  const [initial, setInitial] = useState<ConfigPayload | null>(null);
  const [current, setCurrent] = useState<ConfigPayload | null>(null);
  const [saving, setSaving] = useState(false);
  const fetchConfig = useConfigFetcher(props.workspaceId, props.meta);
  const configIdentity = `${props.workspaceId}:${props.meta.key}`;
  const { data: loadedConfig, loading } = useApiQuery(fetchConfig, [
    props.workspaceId,
    props.meta.key
  ], {
    onError: (message) => {
      showToast({ message: t("config:error.load", { section: title, message }), type: "error" });
    }
  });
  useLoadedConfig(loadedConfig, configIdentity, initial, current, setInitial, setCurrent);
  const dirty = useMemo(() => configDirty(initial, current), [current, initial]);
  useSectionDirtyReport(props.meta.key, dirty, props.onDirtyChange);
  return {
    current,
    dirty,
    loading,
    saving,
    handleChange: (key, value) => setCurrent((prev) => patchConfigField(prev, key, value)),
    handleReset: () => setCurrent(initial),
    handleSave: useSaveConfigSection(props, title, t, current, initial, showToast, setInitial, setSaving)
  };
}

function useConfigFetcher(workspaceId: string, meta: SectionMeta) {
  return useCallback(async (signal: AbortSignal): Promise<ConfigPayload> => {
    const data = await apiFetch<ConfigPayload>(`/config/${workspaceId}/${meta.key}`, { signal });
    return normalizeConfigPayload(data);
  }, [meta.key, workspaceId]);
}

function useLoadedConfig(
  loadedConfig: ConfigPayload | null,
  configIdentity: string,
  initial: ConfigPayload | null,
  current: ConfigPayload | null,
  setInitial: Dispatch<SetStateAction<ConfigPayload | null>>,
  setCurrent: Dispatch<SetStateAction<ConfigPayload | null>>
) {
  const identityRef = useRef(configIdentity);
  const seenConfigRef = useRef<ConfigPayload | null>(null);
  useEffect(() => {
    if (identityRef.current !== configIdentity) {
      identityRef.current = configIdentity;
      seenConfigRef.current = loadedConfig;
      setInitial(null);
      setCurrent(null);
      return;
    }
    if (loadedConfig === null || loadedConfig === seenConfigRef.current) return;
    seenConfigRef.current = loadedConfig;
    if (configDirty(initial, current)) return;
    setInitial(loadedConfig);
    setCurrent(loadedConfig);
  }, [configIdentity, current, initial, loadedConfig, setCurrent, setInitial]);
}

function useSectionDirtyReport(
  key: SectionKey,
  dirty: boolean,
  onDirtyChange: (key: SectionKey, dirty: boolean) => void
) {
  useEffect(() => {
    onDirtyChange(key, dirty);
  }, [dirty, key, onDirtyChange]);
  useEffect(() => () => onDirtyChange(key, false), [key, onDirtyChange]);
}

function useSaveConfigSection(
  props: ConfigSectionProps,
  title: string,
  t: Translate,
  current: ConfigPayload | null,
  initial: ConfigPayload | null,
  showToast: ReturnType<typeof useToasts>["showToast"],
  setInitial: Dispatch<SetStateAction<ConfigPayload | null>>,
  setSaving: (saving: boolean) => void
) {
  return useCallback(async () => {
    if (!current) return;
    const savedConfig = current;
    const baselineAtSave = initial;
    try {
      setSaving(true);
      const result = await patchSectionConfig(props.workspaceId, props.meta.key, savedConfig);
      showToast({
        message: result.requires_daemon_restart
          ? t("config:toast.patchedRestart", { section: title })
          : t("config:toast.saved", { section: title }),
        type: "success"
      });
      setInitial((previous) => previous === baselineAtSave ? savedConfig : previous);
      if (result.requires_daemon_restart) props.onRequiresRestart();
    } catch (err) {
      if ((err as ApiError).status !== 401) {
        showToast({ message: t("config:error.save", { section: title, message: (err as Error).message }), type: "error" });
      }
    } finally {
      setSaving(false);
    }
  }, [current, initial, props, setInitial, setSaving, showToast, t, title]);
}

function ConfigSectionView(props: { readonly meta: SectionMeta; readonly title: string; readonly state: ConfigSectionState; readonly t: Translate }) {
  return (
    <div className="mb-12 border-b border-beige-200 pb-8">
      <ConfigSectionHeader meta={props.meta} title={props.title} dirty={props.state.dirty} t={props.t} />
      <div className="space-y-4">
        {props.state.current
          ? Object.entries(props.state.current).map(([key, value]) => (
              <ConfigFieldRow key={key} fieldKey={key} value={value} onChange={(next) => props.state.handleChange(key, next)} t={props.t} />
            ))
          : null}
      </div>
      <ConfigSectionActions state={props.state} t={props.t} />
    </div>
  );
}

function ConfigSectionHeader(props: { readonly meta: SectionMeta; readonly title: string; readonly dirty: boolean; readonly t: Translate }) {
  return (
    <div className="mb-6 flex items-center gap-3">
      <div className="text-ink-600">{props.meta.icon}</div>
      <h2 className="text-xl font-bold uppercase tracking-wider text-ink-600">{props.title}</h2>
      <span
        data-testid={`dirty-dot-${props.meta.key}`}
        className={clsx("h-1.5 w-1.5 rounded-full transition-colors", props.dirty ? "bg-state-warm" : "bg-morandi-green")}
        aria-label={props.t(props.dirty ? "config:dirty.unsaved" : "config:dirty.synced")}
      />
    </div>
  );
}

function ConfigSectionActions(props: { readonly state: ConfigSectionState; readonly t: Translate }) {
  return (
    <div className="mt-6 flex justify-end gap-3">
      <button type="button" onClick={props.state.handleReset} disabled={!props.state.dirty || props.state.saving} className="flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-widest text-ink-700/60 transition-colors hover:text-ink-700 disabled:opacity-30">
        <RotateCcw className="h-3 w-3" /> {props.t("config:action.discard")}
      </button>
      <button type="button" onClick={() => void props.state.handleSave()} disabled={props.state.saving || !props.state.dirty} className={commitButtonClass(props.state.dirty)}>
        {props.state.saving ? props.t("config:action.saving") : <><Save className="h-4 w-4" />{props.t("config:action.commit")}</>}
      </button>
    </div>
  );
}

function ConfigFieldRow(props: {
  readonly fieldKey: string;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
  readonly t: Translate;
}) {
  const isObjectBag = typeof props.value === "object" && props.value !== null && !Array.isArray(props.value);
  return (
    <div className="group flex flex-col justify-between gap-2 py-2 sm:flex-row sm:items-center">
      <label className="text-xs font-mono uppercase tracking-widest text-ink-700/60">
        {props.fieldKey}
      </label>
      <div className="flex items-center gap-4">
        <ConfigFieldControl value={props.value} onChange={props.onChange} t={props.t} isObjectBag={isObjectBag} />
      </div>
    </div>
  );
}

function ConfigFieldControl(props: {
  readonly value: unknown;
  readonly isObjectBag: boolean;
  readonly onChange: (next: unknown) => void;
  readonly t: Translate;
}) {
  if (typeof props.value === "boolean") {
    return <ToggleSwitch enabled={props.value} label={props.t("config:field.toggleAria")} onToggle={() => props.onChange(!props.value)} />;
  }
  if (props.isObjectBag) {
    return <span className="text-xs italic text-ink-700/40">{props.t("config:field.objectSummary", { count: Object.keys(props.value as Record<string, string>).length })}</span>;
  }
  return <ConfigTextInput value={props.value as string | number | null} onChange={props.onChange} />;
}

function ConfigTextInput(props: {
  readonly value: string | number | null;
  readonly onChange: (next: unknown) => void;
}) {
  return (
    <input
      type={typeof props.value === "number" ? "number" : "text"}
      value={props.value ?? ""}
      onChange={(event) => props.onChange(typeof props.value === "number" ? Number(event.target.value) : event.target.value)}
      className="min-w-[200px] border-b border-beige-300 bg-transparent py-1 text-right font-mono text-sm text-ink-700 outline-none focus:border-ink-600"
    />
  );
}

function LoadingConfigSection(props: { readonly title: string; readonly t: Translate }) {
  return (
    <div className="py-4 text-xs uppercase tracking-widest text-ink-700/40 animate-pulse">
      {props.t("config:loadingSection", { section: props.title })}
    </div>
  );
}

async function patchSectionConfig(workspaceId: string, key: SectionKey, current: ConfigPayload): Promise<PatchResult> {
  return apiFetch<PatchResult>(`/config/${workspaceId}/${key}`, { method: "PATCH", body: current });
}

function patchConfigField(current: ConfigPayload | null, key: string, value: unknown): ConfigPayload | null {
  return current ? { ...current, [key]: value } : current;
}

function configDirty(initial: ConfigPayload | null, current: ConfigPayload | null): boolean {
  if (!initial || !current) return false;
  return JSON.stringify(initial) !== JSON.stringify(current);
}

function commitButtonClass(dirty: boolean): string {
  return clsx(
    "flex items-center gap-2 rounded px-4 py-2 text-xs font-bold uppercase tracking-widest transition-colors",
    dirty ? "bg-ink-600 text-beige-50 hover:bg-ink-700" : "cursor-not-allowed bg-beige-300 text-ink-700/40"
  );
}

function normalizeConfigPayload(payload: ConfigPayload): ConfigPayload {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => !HIDDEN_CONFIG_KEYS.has(key))
  );
}
