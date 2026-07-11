import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RotateCcw, Save } from "lucide-react";
import { clsx } from "clsx";
import { apiFetch, type ApiError } from "../api";
import { useApiQuery } from "../hooks/useApiQuery";
import { useToasts } from "../components/toast";
import { ToggleSwitch } from "../components/config-form-fields";
import type { SectionKey } from "./config-page-state";

export interface SectionMeta {
  readonly key: SectionKey;
  readonly title: string;
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
  const state = useConfigSectionState(props);
  if (state.loading) return <LoadingConfigSection title={props.meta.title} />;
  return <ConfigSectionView meta={props.meta} state={state} />;
}

function useConfigSectionState(props: ConfigSectionProps): ConfigSectionState {
  const { showToast } = useToasts();
  const [initial, setInitial] = useState<ConfigPayload | null>(null);
  const [current, setCurrent] = useState<ConfigPayload | null>(null);
  const [saving, setSaving] = useState(false);
  const fetchConfig = useConfigFetcher(props.workspaceId, props.meta);
  const { data: loadedConfig, loading } = useApiQuery(fetchConfig, [
    props.workspaceId,
    props.meta.key
  ], {
    onError: (message) => {
      showToast({ message: `Failed to load ${props.meta.title}: ${message}`, type: "error" });
    }
  });
  useLoadedConfig(loadedConfig, setInitial, setCurrent);
  const dirty = useMemo(() => configDirty(initial, current), [current, initial]);
  useSectionDirtyReport(props.meta.key, dirty, props.onDirtyChange);
  return {
    current,
    dirty,
    loading,
    saving,
    handleChange: (key, value) => setCurrent((prev) => patchConfigField(prev, key, value)),
    handleReset: () => setCurrent(initial),
    handleSave: useSaveConfigSection(props, current, showToast, setInitial, setSaving)
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
  setInitial: (payload: ConfigPayload) => void,
  setCurrent: (payload: ConfigPayload) => void
) {
  useEffect(() => {
    if (loadedConfig === null) return;
    setInitial(loadedConfig);
    setCurrent(loadedConfig);
  }, [loadedConfig, setInitial, setCurrent]);
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
  current: ConfigPayload | null,
  showToast: ReturnType<typeof useToasts>["showToast"],
  setInitial: (payload: ConfigPayload) => void,
  setSaving: (saving: boolean) => void
) {
  return useCallback(async () => {
    if (!current) return;
    try {
      setSaving(true);
      const result = await patchSectionConfig(props.workspaceId, props.meta.key, current);
      showToast({
        message: result.requires_daemon_restart
          ? `${props.meta.title} patched · daemon restart pending`
          : `${props.meta.title} saved`,
        type: "success"
      });
      setInitial(current);
      if (result.requires_daemon_restart) props.onRequiresRestart();
    } catch (err) {
      if ((err as ApiError).status !== 401) {
        showToast({ message: `Failed to save ${props.meta.title}: ${(err as Error).message}`, type: "error" });
      }
    } finally {
      setSaving(false);
    }
  }, [current, props, setInitial, setSaving, showToast]);
}

function ConfigSectionView(props: { readonly meta: SectionMeta; readonly state: ConfigSectionState }) {
  return (
    <div className="mb-12 border-b border-beige-200 pb-8">
      <ConfigSectionHeader meta={props.meta} dirty={props.state.dirty} />
      <div className="space-y-4">
        {props.state.current
          ? Object.entries(props.state.current).map(([key, value]) => (
              <ConfigFieldRow key={key} fieldKey={key} value={value} onChange={(next) => props.state.handleChange(key, next)} />
            ))
          : null}
      </div>
      <ConfigSectionActions state={props.state} />
    </div>
  );
}

function ConfigSectionHeader(props: { readonly meta: SectionMeta; readonly dirty: boolean }) {
  return (
    <div className="mb-6 flex items-center gap-3">
      <div className="text-ink-600">{props.meta.icon}</div>
      <h2 className="text-xl font-bold uppercase tracking-wider text-ink-600">{props.meta.title}</h2>
      <span
        data-testid={`dirty-dot-${props.meta.key}`}
        className={clsx("h-1.5 w-1.5 rounded-full transition-colors", props.dirty ? "bg-state-warm" : "bg-morandi-green")}
        aria-label={props.dirty ? "section has unsaved changes" : "section in sync"}
      />
    </div>
  );
}

function ConfigSectionActions(props: { readonly state: ConfigSectionState }) {
  return (
    <div className="mt-6 flex justify-end gap-3">
      <button type="button" onClick={props.state.handleReset} disabled={!props.state.dirty || props.state.saving} className="flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-widest text-ink-700/60 transition-colors hover:text-ink-700 disabled:opacity-30">
        <RotateCcw className="h-3 w-3" /> Discard
      </button>
      <button type="button" onClick={() => void props.state.handleSave()} disabled={props.state.saving || !props.state.dirty} className={commitButtonClass(props.state.dirty)}>
        {props.state.saving ? "Saving..." : <><Save className="h-4 w-4" />Commit Changes</>}
      </button>
    </div>
  );
}

function ConfigFieldRow(props: {
  readonly fieldKey: string;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
}) {
  const isObjectBag = typeof props.value === "object" && props.value !== null && !Array.isArray(props.value);
  return (
    <div className="group flex flex-col justify-between gap-2 py-2 sm:flex-row sm:items-center">
      <label className="text-xs font-mono uppercase tracking-widest text-ink-700/60">
        {props.fieldKey.replace(/_/g, " ")}
      </label>
      <div className="flex items-center gap-4">
        <ConfigFieldControl {...props} isObjectBag={isObjectBag} />
      </div>
    </div>
  );
}

function ConfigFieldControl(props: {
  readonly value: unknown;
  readonly isObjectBag: boolean;
  readonly onChange: (next: unknown) => void;
}) {
  if (typeof props.value === "boolean") {
    return <ToggleSwitch enabled={props.value} label="Toggle config value" onToggle={() => props.onChange(!props.value)} />;
  }
  if (props.isObjectBag) {
    return <span className="text-xs italic text-ink-700/40">{Object.keys(props.value as Record<string, string>).length} entries · edit via CLI</span>;
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

function LoadingConfigSection(props: { readonly title: string }) {
  return (
    <div className="py-4 text-xs uppercase tracking-widest text-ink-700/40 animate-pulse">
      Loading {props.title}...
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
