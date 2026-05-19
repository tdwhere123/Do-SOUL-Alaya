import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Save } from "lucide-react";
import { clsx } from "clsx";
import { apiFetch, type ApiError } from "../api";
import { useToasts } from "./Toast";
import type { ManifestationBudgetConfig } from "@do-soul/alaya-protocol";

interface ManifestationBudgetConfigEnvelope {
  readonly success?: boolean;
  readonly data?: ManifestationBudgetConfig;
}

interface PatchResult {
  readonly success?: boolean;
  readonly requires_daemon_restart?: boolean;
  readonly data?: ManifestationBudgetConfig;
}

interface Props {
  readonly workspaceId: string;
}

export default function ManifestationBudgetForm({ workspaceId }: Props) {
  const { showToast } = useToasts();
  const [initial, setInitial] = useState<ManifestationBudgetConfig | null>(null);
  const [current, setCurrent] = useState<ManifestationBudgetConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const envelope = await apiFetch<ManifestationBudgetConfig | ManifestationBudgetConfigEnvelope>(
          `/config/${workspaceId}/manifestation-budget`
        );
        const data = unwrapManifestationBudgetConfig(envelope);
        if (cancelled) return;
        setInitial(data);
        setCurrent(data);
      } catch (err) {
        if ((err as ApiError).status === 401) return;
        showToast({
          message: `Failed to load manifestation budget: ${(err as Error).message}`,
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
  }, [workspaceId, showToast]);

  const dirty = useMemo(() => {
    if (initial === null || current === null) return false;
    return JSON.stringify(initial) !== JSON.stringify(current);
  }, [initial, current]);

  const handleSave = async () => {
    if (current === null) return;
    setSaving(true);
    try {
      const result = await apiFetch<PatchResult>(
        `/config/${workspaceId}/manifestation-budget`,
        {
          method: "PATCH",
          body: current
        }
      );
      const saved = result.data ?? current;
      setInitial(saved);
      setCurrent(saved);
      showToast({
        message: "Manifestation budget patched",
        type: "success"
      });
    } catch (err) {
      if ((err as ApiError).status === 401) return;
      showToast({
        message: `Failed to patch manifestation budget: ${(err as Error).message}`,
        type: "error"
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="py-4 text-xs text-ink-700/40 uppercase tracking-widest animate-pulse">
        Loading Manifestation Budget...
      </div>
    );
  }

  if (current === null) {
    return null;
  }

  return (
    <div className="space-y-5">
      <NumberRow
        label="stance bias cap"
        value={current.stance_bias_cap}
        onChange={(value) => patchConfig({ stance_bias_cap: value })}
      />
      <NumberRow
        label="dialogue nudge cap"
        value={current.dialogue_nudge_cap}
        onChange={(value) => patchConfig({ dialogue_nudge_cap: value })}
      />
      <NumberRow
        label="lens entry cap"
        value={current.lens_entry_cap}
        onChange={(value) => patchConfig({ lens_entry_cap: value })}
      />
      <NumberRow
        label="nudge pressure"
        step={0.05}
        value={current.escalation_policy.nudge_min_pressure}
        onChange={(value) => patchPolicy({ nudge_min_pressure: value })}
      />
      <NumberRow
        label="nudge confidence"
        step={0.05}
        value={current.escalation_policy.nudge_min_confidence}
        onChange={(value) => patchPolicy({ nudge_min_confidence: value })}
      />
      <NumberRow
        label="lens pressure"
        step={0.05}
        value={current.escalation_policy.lens_min_pressure}
        onChange={(value) => patchPolicy({ lens_min_pressure: value })}
      />
      <NumberRow
        label="lens confidence"
        step={0.05}
        value={current.escalation_policy.lens_min_confidence}
        onChange={(value) => patchPolicy({ lens_min_confidence: value })}
      />
      <ToggleRow
        label="task coupling required"
        value={current.escalation_policy.lens_requires_task_coupling}
        onChange={(value) => patchPolicy({ lens_requires_task_coupling: value })}
      />
      <ToggleRow
        label="governance ceiling required"
        value={current.escalation_policy.lens_requires_governance_ceiling}
        onChange={(value) => patchPolicy({ lens_requires_governance_ceiling: value })}
      />

      <div className="pt-4 flex items-center justify-between">
        <span className="text-[10px] text-ink-700/40 uppercase tracking-widest">
          {dirty ? "unsaved changes" : "in sync with daemon"}
        </span>
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="flex items-center gap-2 px-4 py-2 bg-ink-600 text-beige-50 rounded text-xs font-bold uppercase tracking-widest hover:bg-ink-700 disabled:opacity-40 transition-colors"
        >
          {saving ? "Saving..." : (
            <>
              <Save className="w-4 h-4" />
              Commit Budget
            </>
          )}
        </button>
      </div>
    </div>
  );

  function patchConfig(patch: Partial<ManifestationBudgetConfig>) {
    setCurrent((prev) => (prev === null ? prev : { ...prev, ...patch }));
  }

  function patchPolicy(patch: Partial<ManifestationBudgetConfig["escalation_policy"]>) {
    setCurrent((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            escalation_policy: {
              ...prev.escalation_policy,
              ...patch
            }
          }
    );
  }
}

function NumberRow({
  label,
  value,
  step = 1,
  onChange
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <FieldRow label={label}>
      <input
        type="number"
        min={0}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
        className="bg-transparent border-b border-beige-300 focus:border-ink-600 outline-none text-sm text-ink-700 font-mono text-right py-1 min-w-[180px]"
      />
    </FieldRow>
  );
}

function ToggleRow({
  label,
  value,
  onChange
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <FieldRow label={label}>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={clsx(
          "w-10 h-5 rounded-full relative transition-colors duration-300",
          value ? "bg-morandi-green" : "bg-beige-300"
        )}
        aria-pressed={value}
        aria-label={`Toggle ${label}`}
      >
        <div
          className={clsx(
            "absolute top-1 w-3 h-3 rounded-full bg-beige-50 transition-transform duration-300",
            value ? "left-6" : "left-1"
          )}
        />
      </button>
    </FieldRow>
  );
}

function FieldRow({
  label,
  children
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2">
      <label className="text-xs font-mono text-ink-700/60 uppercase tracking-widest">
        {label}
      </label>
      <div>{children}</div>
    </div>
  );
}

function unwrapManifestationBudgetConfig(value: unknown): ManifestationBudgetConfig {
  if (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof (value as ManifestationBudgetConfigEnvelope).data === "object"
  ) {
    return (value as ManifestationBudgetConfigEnvelope).data as ManifestationBudgetConfig;
  }
  return value as ManifestationBudgetConfig;
}
