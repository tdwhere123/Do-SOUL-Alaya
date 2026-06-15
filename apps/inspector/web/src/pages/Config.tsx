import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Cpu,
  Globe,
  KeyRound,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  X
} from "lucide-react";
import { clsx } from "clsx";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useApiQuery } from "../hooks/useApiQuery";
import { useToasts } from "../components/Toast";
import EmbeddingSupplementForm from "../components/EmbeddingSupplementForm";
import GardenComputeForm from "../components/GardenComputeForm";
import ManifestationBudgetForm from "../components/ManifestationBudgetForm";
import { useI18n } from "../i18n/Locale";

interface PatchResult {
  readonly success?: boolean;
  readonly requires_daemon_restart?: boolean;
  readonly data?: unknown;
}

type SectionKey = "soul" | "strategy" | "environment";

interface SectionMeta {
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

type ConfigPayload = Record<string, unknown>;

const SECTIONS: ReadonlyArray<SectionMeta> = [
  { key: "soul", title: "Soul Runtime", icon: <Cpu className="h-6 w-6" /> },
  {
    key: "strategy",
    title: "Strategy & Guardrails",
    icon: <ShieldCheck className="h-6 w-6" />
  },
  { key: "environment", title: "Environment", icon: <Globe className="h-6 w-6" /> }
];

const HIDDEN_CONFIG_KEYS = new Set(["config_version"]);

/**
 * ConfigPage lets operators patch runtime configuration while keeping
 * dirty-state warnings, restart guidance, and specialized forms in one place.
 */
export default function ConfigPage() {
  const workspaceId = getWorkspaceId();
  const { t } = useI18n();
  const [dirtySections, setDirtySections] = useState<Set<SectionKey>>(new Set());
  const [restartPending, setRestartPending] = useState(false);

  const handleSectionDirtyChange = useCallback((key: SectionKey, dirty: boolean) => {
    setDirtySections((previous) => {
      const next = new Set(previous);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const handleRestartRequired = useCallback(() => {
    setRestartPending(true);
  }, []);

  const dismissRestart = useCallback(() => {
    setRestartPending(false);
  }, []);

  useEffect(() => {
    if (dirtySections.size === 0) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "Unsaved configuration changes will be lost.";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtySections]);

  if (workspaceId === null) {
    return (
      <div className="h-full w-full overflow-y-auto">
        <div
          role="alert"
          data-testid="config-no-workspace"
          className="mx-auto w-full max-w-4xl p-8 font-mono text-sm text-ink-700"
        >
          <h1 className="mb-3 text-2xl font-bold uppercase tracking-widest text-ink-600">
            {t("common:noWorkspace")}
          </h1>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-8 font-mono">
        {restartPending ? (
          <div
            role="alert"
            className="mb-8 flex items-start justify-between gap-4 rounded border border-beige-300 bg-beige-200/60 px-4 py-3 text-xs text-ink-700"
          >
            <div className="flex-1">
              <p className="mb-1 font-bold uppercase tracking-widest">Restart Daemon Pending</p>
              <p className="text-ink-700/80">
                Apply changes by restarting the daemon. The Inspector cannot do this for you.
              </p>
              <code className="mt-2 inline-block rounded bg-beige-100 px-2 py-1 text-[10px]">
                alaya stop && alaya start
              </code>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText("alaya stop && alaya start")}
                className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-600 transition-colors hover:bg-beige-200 rounded"
              >
                Copy Command
              </button>
              <button
                type="button"
                onClick={dismissRestart}
                className="text-ink-700/40 hover:text-ink-700"
                aria-label="Dismiss restart banner"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : null}

        <header className="mb-12">
          <h1 className="mb-2 text-3xl font-bold text-ink-600">System Configuration</h1>
          <p className="text-sm text-ink-700/60">
            Fine-tune the Alaya engine behavior and strategy parameters.
          </p>
        </header>

        {SECTIONS.map((section) => (
          <ConfigSection
            key={section.key}
            meta={section}
            workspaceId={workspaceId}
            onDirtyChange={handleSectionDirtyChange}
            onRequiresRestart={handleRestartRequired}
          />
        ))}

        <div className="mb-12 border-b border-beige-200 pb-8">
          <div className="mb-6 flex items-center gap-3">
            <div className="text-ink-600">
              <KeyRound className="h-6 w-6" />
            </div>
            <h2 className="text-xl font-bold uppercase tracking-wider text-ink-600">
              Embedding Supplement
            </h2>
          </div>
          <EmbeddingSupplementForm
            onRequiresRestart={handleRestartRequired}
            workspaceId={workspaceId}
          />
        </div>

        <div className="mb-12 border-b border-beige-200 pb-8">
          <div className="mb-6 flex items-center gap-3">
            <div className="text-ink-600">
              <KeyRound className="h-6 w-6" />
            </div>
            <h2 className="text-xl font-bold uppercase tracking-wider text-ink-600">
              Garden Compute
            </h2>
          </div>
          <GardenComputeForm
            onRequiresRestart={handleRestartRequired}
            workspaceId={workspaceId}
          />
        </div>

        <div className="mb-12 border-b border-beige-200 pb-8">
          <div className="mb-6 flex items-center gap-3">
            <div className="text-ink-600">
              <SlidersHorizontal className="h-6 w-6" />
            </div>
            <h2 className="text-xl font-bold uppercase tracking-wider text-ink-600">
              Manifestation Budget
            </h2>
          </div>
          <ManifestationBudgetForm workspaceId={workspaceId} />
        </div>

        <div className="mt-12 rounded-lg border border-beige-200 bg-beige-200/30 p-6">
          <h3 className="mb-4 text-sm font-bold uppercase tracking-widest text-ink-600">
            Diagnostic Information
          </h3>
          <div className="space-y-1 text-[10px] text-ink-700/60">
            <p>WORKSPACE_ID: {workspaceId}</p>
            <p>SCHEMA_VERSION: v0.1.0-alpha.4</p>
            <p>DAEMON_TARGET: LOCAL_HOST_PROXY</p>
            <p>DIRTY_SECTIONS: {dirtySections.size}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfigSection({
  meta,
  workspaceId,
  onDirtyChange,
  onRequiresRestart
}: ConfigSectionProps) {
  const { showToast } = useToasts();
  const [initial, setInitial] = useState<ConfigPayload | null>(null);
  const [current, setCurrent] = useState<ConfigPayload | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchConfig = useCallback(async (signal: AbortSignal): Promise<ConfigPayload> => {
    const data = await apiFetch<ConfigPayload>(`/config/${workspaceId}/${meta.key}`, { signal });
    return normalizeConfigPayload(data);
  }, [meta.key, workspaceId]);

  const { data: loadedConfig, loading } = useApiQuery(fetchConfig, [workspaceId, meta.key], {
    onError: (message) => {
      showToast({ message: `Failed to load ${meta.title}: ${message}`, type: "error" });
    }
  });

  useEffect(() => {
    if (loadedConfig === null) return;
    setInitial(loadedConfig);
    setCurrent(loadedConfig);
  }, [loadedConfig]);

  const dirty = useMemo(() => {
    if (!initial || !current) return false;
    return JSON.stringify(initial) !== JSON.stringify(current);
  }, [current, initial]);

  useEffect(() => {
    onDirtyChange(meta.key, dirty);
  }, [dirty, meta.key, onDirtyChange]);

  useEffect(() => {
    return () => onDirtyChange(meta.key, false);
  }, [meta.key, onDirtyChange]);

  const handleSave = async () => {
    if (!current) return;
    try {
      setSaving(true);
      const result = await apiFetch<PatchResult>(`/config/${workspaceId}/${meta.key}`, {
        method: "PATCH",
        body: current
      });
      showToast({ message: `${meta.title} patched · daemon restart pending`, type: "success" });
      setInitial(current);
      if (result.requires_daemon_restart) {
        onRequiresRestart();
      }
    } catch (err) {
      if ((err as ApiError).status === 401) return;
      showToast({
        message: `Failed to save ${meta.title}: ${(err as Error).message}`,
        type: "error"
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (initial) {
      setCurrent(initial);
    }
  };

  const handleChange = (key: string, value: unknown) => {
    setCurrent((previous) => (previous ? { ...previous, [key]: value } : previous));
  };

  if (loading) {
    return (
      <div className="py-4 text-xs uppercase tracking-widest text-ink-700/40 animate-pulse">
        Loading {meta.title}...
      </div>
    );
  }

  return (
    <div className="mb-12 border-b border-beige-200 pb-8">
      <div className="mb-6 flex items-center gap-3">
        <div className="text-ink-600">{meta.icon}</div>
        <h2 className="text-xl font-bold uppercase tracking-wider text-ink-600">{meta.title}</h2>
        <span
          data-testid={`dirty-dot-${meta.key}`}
          className={clsx(
            "h-1.5 w-1.5 rounded-full transition-colors",
            dirty ? "bg-state-warm" : "bg-morandi-green"
          )}
          aria-label={dirty ? "section has unsaved changes" : "section in sync"}
        />
      </div>

      <div className="space-y-4">
        {current
          ? Object.entries(current).map(([key, value]) => (
              <FieldRow
                key={key}
                fieldKey={key}
                value={value}
                onChange={(nextValue) => handleChange(key, nextValue)}
              />
            ))
          : null}
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={handleReset}
          disabled={!dirty || saving}
          className="flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-widest text-ink-700/60 transition-colors hover:text-ink-700 disabled:opacity-30"
        >
          <RotateCcw className="h-3 w-3" /> Discard
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          className={clsx(
            "flex items-center gap-2 rounded px-4 py-2 text-xs font-bold uppercase tracking-widest transition-colors",
            dirty
              ? "bg-ink-600 text-beige-50 hover:bg-ink-700"
              : "cursor-not-allowed bg-beige-300 text-ink-700/40"
          )}
        >
          {saving ? (
            "Saving..."
          ) : (
            <>
              <Save className="h-4 w-4" />
              Commit Changes
            </>
          )}
        </button>
      </div>
    </div>
  );
}

interface FieldRowProps {
  readonly fieldKey: string;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
}

function FieldRow({ fieldKey, value, onChange }: FieldRowProps) {
  const isEnvVarsBag = typeof value === "object" && value !== null && !Array.isArray(value);

  return (
    <div className="group flex flex-col justify-between gap-2 py-2 sm:flex-row sm:items-center">
      <label className="text-xs font-mono uppercase tracking-widest text-ink-700/60">
        {fieldKey.replace(/_/g, " ")}
      </label>
      <div className="flex items-center gap-4">
        {typeof value === "boolean" ? (
          <button
            type="button"
            onClick={() => onChange(!value)}
            className={clsx(
              "relative h-5 w-10 rounded-full transition-colors duration-300",
              value ? "bg-morandi-green" : "bg-beige-300"
            )}
            aria-pressed={value}
          >
            <div
              className={clsx(
                "absolute top-1 h-3 w-3 rounded-full bg-beige-50 transition-transform duration-300",
                value ? "left-6" : "left-1"
              )}
            />
          </button>
        ) : isEnvVarsBag ? (
          <span className="text-xs italic text-ink-700/40">
            {Object.keys(value as Record<string, string>).length} entries · edit via CLI
          </span>
        ) : (
          <input
            type={typeof value === "number" ? "number" : "text"}
            value={(value as string | number | null) ?? ""}
            onChange={(event) =>
              onChange(typeof value === "number" ? Number(event.target.value) : event.target.value)
            }
            className="min-w-[200px] border-b border-beige-300 bg-transparent py-1 text-right font-mono text-sm text-ink-700 outline-none focus:border-ink-600"
          />
        )}
      </div>
    </div>
  );
}

function normalizeConfigPayload(payload: ConfigPayload): ConfigPayload {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => !HIDDEN_CONFIG_KEYS.has(key))
  );
}
