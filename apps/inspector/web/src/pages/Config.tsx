import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Cpu, Globe, KeyRound, RotateCcw, Save, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import { clsx } from "clsx";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
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

const SECTIONS: ReadonlyArray<SectionMeta> = [
  { key: "soul", title: "Soul Runtime", icon: <Cpu className="w-6 h-6" /> },
  {
    key: "strategy",
    title: "Strategy & Guardrails",
    icon: <ShieldCheck className="w-6 h-6" />
  },
  { key: "environment", title: "Environment", icon: <Globe className="w-6 h-6" /> }
];

export default function ConfigPage() {
  const workspaceId = getWorkspaceId();
  const { t } = useI18n();
  const [dirtySections, setDirtySections] = useState<Set<SectionKey>>(new Set());
  const [restartPending, setRestartPending] = useState(false);

  const handleSectionDirtyChange = useCallback(
    (key: SectionKey, dirty: boolean) => {
      setDirtySections((prev) => {
        const next = new Set(prev);
        if (dirty) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    []
  );

  const handleRestartRequired = useCallback(() => {
    setRestartPending(true);
  }, []);

  const dismissRestart = useCallback(() => setRestartPending(false), []);

  useEffect(() => {
    if (dirtySections.size === 0) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // returnValue is required for legacy browsers; Chrome ignores the string
      // but still shows its own dialog when this property is set.
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
          className="max-w-4xl mx-auto w-full p-8 font-mono text-sm text-ink-700"
        >
          <h1 className="text-2xl font-bold text-ink-600 mb-3 uppercase tracking-widest">
            {t("common:noWorkspace")}
          </h1>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto"><div className="max-w-4xl mx-auto w-full p-8 font-mono">
      {restartPending ? (
        <div
          role="alert"
          className="mb-8 flex items-start justify-between gap-4 px-4 py-3 bg-beige-200/60 border border-beige-300 rounded text-xs text-ink-700"
        >
          <div className="flex-1">
            <p className="font-bold uppercase tracking-widest mb-1">
              Restart Daemon Pending
            </p>
            <p className="text-ink-700/80">
              Apply changes by restarting the daemon. The Inspector cannot do this for
              you.
            </p>
            <code className="inline-block mt-2 px-2 py-1 bg-beige-100 rounded text-[10px]">
              alaya stop && alaya start
            </code>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigator.clipboard.writeText("alaya stop && alaya start")}
              className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-600 hover:bg-beige-200 rounded transition-colors"
            >
              Copy Command
            </button>
            <button
              onClick={dismissRestart}
              className="text-ink-700/40 hover:text-ink-700"
              aria-label="Dismiss restart banner"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : null}

      <header className="mb-12">
        <h1 className="text-3xl font-bold text-ink-600 mb-2">System Configuration</h1>
        <p className="text-ink-700/60 text-sm">
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
        <div className="flex items-center gap-3 mb-6">
          <div className="text-ink-600">
            <KeyRound className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold text-ink-600 uppercase tracking-wider">
            Embedding Supplement
          </h2>
        </div>
        <EmbeddingSupplementForm
          onRequiresRestart={handleRestartRequired}
          workspaceId={workspaceId}
        />
      </div>

      <div className="mb-12 border-b border-beige-200 pb-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="text-ink-600">
            <KeyRound className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold text-ink-600 uppercase tracking-wider">
            Garden Compute
          </h2>
        </div>
        <GardenComputeForm
          onRequiresRestart={handleRestartRequired}
          workspaceId={workspaceId}
        />
      </div>

      <div className="mb-12 border-b border-beige-200 pb-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="text-ink-600">
            <SlidersHorizontal className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold text-ink-600 uppercase tracking-wider">
            Manifestation Budget
          </h2>
        </div>
        <ManifestationBudgetForm workspaceId={workspaceId} />
      </div>

      <div className="mt-12 p-6 bg-beige-200/30 rounded-lg border border-beige-200">
        <h3 className="text-sm font-bold text-ink-600 uppercase tracking-widest mb-4">
          Diagnostic Information
        </h3>
        <div className="text-[10px] text-ink-700/60 space-y-1">
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

interface ConfigSectionProps {
  readonly meta: SectionMeta;
  readonly workspaceId: string;
  readonly onDirtyChange: (key: SectionKey, dirty: boolean) => void;
  readonly onRequiresRestart: () => void;
}

type ConfigPayload = Record<string, unknown>;

function ConfigSection({
  meta,
  workspaceId,
  onDirtyChange,
  onRequiresRestart
}: ConfigSectionProps) {
  const { showToast } = useToasts();
  const [initial, setInitial] = useState<ConfigPayload | null>(null);
  const [current, setCurrent] = useState<ConfigPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await apiFetch<ConfigPayload>(`/config/${workspaceId}/${meta.key}`);
        if (cancelled) return;
        setInitial(data);
        setCurrent(data);
      } catch (err) {
        if ((err as ApiError).status === 401) return;
        showToast({
          message: `Failed to load ${meta.title}: ${(err as Error).message}`,
          type: "error"
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, meta.key, meta.title, showToast]);

  const dirty = useMemo(() => {
    if (!initial || !current) return false;
    return JSON.stringify(initial) !== JSON.stringify(current);
  }, [initial, current]);

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
      const result = await apiFetch<PatchResult>(
        `/config/${workspaceId}/${meta.key}`,
        {
          method: "PATCH",
          body: current
        }
      );
      showToast({
        message: `${meta.title} patched · daemon restart pending`,
        type: "success"
      });
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
    if (initial) setCurrent(initial);
  };

  const handleChange = (key: string, value: unknown) => {
    setCurrent((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  if (loading) {
    return (
      <div className="py-4 animate-pulse text-xs text-ink-700/40 uppercase tracking-widest">
        Loading {meta.title}...
      </div>
    );
  }

  return (
    <div className="mb-12 border-b border-beige-200 pb-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="text-ink-600">{meta.icon}</div>
        <h2 className="text-xl font-bold text-ink-600 uppercase tracking-wider">
          {meta.title}
        </h2>
        <span
          data-testid={`dirty-dot-${meta.key}`}
          className={clsx(
            "w-1.5 h-1.5 rounded-full transition-colors",
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
                onChange={(v) => handleChange(key, v)}
              />
            ))
          : null}
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <button
          onClick={handleReset}
          disabled={!dirty || saving}
          className="flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-widest text-ink-700/60 hover:text-ink-700 disabled:opacity-30 transition-colors"
        >
          <RotateCcw className="w-3 h-3" /> Discard
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className={clsx(
            "flex items-center gap-2 px-4 py-2 rounded text-xs font-bold uppercase tracking-widest transition-colors",
            dirty
              ? "bg-ink-600 text-beige-50 hover:bg-ink-700"
              : "bg-beige-300 text-ink-700/40 cursor-not-allowed"
          )}
        >
          {saving ? "Saving..." : (
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

interface FieldRowProps {
  readonly fieldKey: string;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
}

function FieldRow({ fieldKey, value, onChange }: FieldRowProps) {
  const isEnvVarsBag =
    typeof value === "object" && value !== null && !Array.isArray(value);

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2 group">
      <label className="text-xs font-mono text-ink-700/60 uppercase tracking-widest">
        {fieldKey.replace(/_/g, " ")}
      </label>
      <div className="flex items-center gap-4">
        {typeof value === "boolean" ? (
          <button
            type="button"
            onClick={() => onChange(!value)}
            className={clsx(
              "w-10 h-5 rounded-full relative transition-colors duration-300",
              value ? "bg-morandi-green" : "bg-beige-300"
            )}
            aria-pressed={value}
          >
            <div
              className={clsx(
                "absolute top-1 w-3 h-3 rounded-full bg-beige-50 transition-transform duration-300",
                value ? "left-6" : "left-1"
              )}
            />
          </button>
        ) : isEnvVarsBag ? (
          <span className="text-xs text-ink-700/40 italic">
            {Object.keys(value as Record<string, string>).length} entries · edit via CLI
          </span>
        ) : (
          <input
            type={typeof value === "number" ? "number" : "text"}
            value={(value as string | number | null) ?? ""}
            onChange={(e) =>
              onChange(
                typeof value === "number" ? Number(e.target.value) : e.target.value
              )
            }
            className="bg-transparent border-b border-beige-300 focus:border-ink-600 outline-none text-sm text-ink-700 font-mono text-right py-1 min-w-[200px]"
          />
        )}
      </div>
    </div>
  );
}
