import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { ManifestationBudgetConfig } from "@do-soul/alaya-protocol";
import { apiFetch, type ApiError } from "../api";
import { useToasts } from "./toast";

interface ManifestationBudgetConfigEnvelope {
  readonly success?: boolean;
  readonly data?: ManifestationBudgetConfig;
}

interface PatchResult {
  readonly success?: boolean;
  readonly requires_daemon_restart?: boolean;
  readonly data?: ManifestationBudgetConfig;
}

type ShowToast = ReturnType<typeof useToasts>["showToast"];

export interface ManifestationBudgetState {
  readonly current: ManifestationBudgetConfig | null;
  readonly dirty: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly patchConfig: (patch: Partial<ManifestationBudgetConfig>) => void;
  readonly patchPolicy: (
    patch: Partial<ManifestationBudgetConfig["escalation_policy"]>
  ) => void;
  readonly save: () => Promise<void>;
}

export function useManifestationBudgetState(workspaceId: string): ManifestationBudgetState {
  const { showToast } = useToasts();
  const [initial, setInitial] = useState<ManifestationBudgetConfig | null>(null);
  const [current, setCurrent] = useState<ManifestationBudgetConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const currentRevisionRef = useRef(0);

  useLoadManifestationBudget(workspaceId, showToast, setInitial, setCurrent, setLoading);
  const dirty = useMemo(() => isDirty(initial, current), [initial, current]);
  const patchConfig = useCallback(
    (patch: Partial<ManifestationBudgetConfig>) => {
      currentRevisionRef.current += 1;
      setCurrent((prev) => patchRoot(prev, patch));
    },
    []
  );
  const patchPolicy = useCallback(
    (patch: Partial<ManifestationBudgetConfig["escalation_policy"]>) => {
      currentRevisionRef.current += 1;
      setCurrent((prev) => patchEscalationPolicy(prev, patch));
    },
    []
  );
  const save = useSaveManifestationBudget(
    workspaceId,
    current,
    currentRevisionRef,
    showToast,
    setInitial,
    setCurrent,
    setSaving
  );

  return { current, dirty, loading, patchConfig, patchPolicy, save, saving };
}

function useLoadManifestationBudget(
  workspaceId: string,
  showToast: ShowToast,
  setInitial: (config: ManifestationBudgetConfig) => void,
  setCurrent: (config: ManifestationBudgetConfig) => void,
  setLoading: (loading: boolean) => void
) {
  useEffect(() => {
    let cancelled = false;
    void loadManifestationBudget(workspaceId, showToast, () => cancelled, (config) => {
      if (cancelled) return;
      setInitial(config);
      setCurrent(config);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, showToast, setInitial, setCurrent, setLoading]);
}

function useSaveManifestationBudget(
  workspaceId: string,
  current: ManifestationBudgetConfig | null,
  currentRevisionRef: MutableRefObject<number>,
  showToast: ShowToast,
  setInitial: (config: ManifestationBudgetConfig) => void,
  setCurrent: (config: ManifestationBudgetConfig) => void,
  setSaving: (saving: boolean) => void
) {
  return useCallback(async () => {
    if (current === null) return;
    const currentRevision = currentRevisionRef.current;
    setSaving(true);
    try {
      const saved = await patchManifestationBudget(workspaceId, current);
      setInitial(saved);
      if (currentRevisionRef.current === currentRevision) {
        setCurrent(saved);
      }
      showToast({ message: "Manifestation budget patched", type: "success" });
    } catch (err) {
      if ((err as ApiError).status !== 401) {
        showToast({
          message: `Failed to patch manifestation budget: ${(err as Error).message}`,
          type: "error"
        });
      }
    } finally {
      setSaving(false);
    }
  }, [current, currentRevisionRef, setCurrent, setInitial, setSaving, showToast, workspaceId]);
}

async function loadManifestationBudget(
  workspaceId: string,
  showToast: ShowToast,
  isCancelled: () => boolean,
  onLoaded: (config: ManifestationBudgetConfig) => void
) {
  try {
    const envelope = await apiFetch<ManifestationBudgetConfig | ManifestationBudgetConfigEnvelope>(
      `/config/${workspaceId}/manifestation-budget`
    );
    onLoaded(unwrapManifestationBudgetConfig(envelope));
  } catch (err) {
    if (!isCancelled() && (err as ApiError).status !== 401) {
      showToast({
        message: `Failed to load manifestation budget: ${(err as Error).message}`,
        type: "error"
      });
    }
  }
}

async function patchManifestationBudget(
  workspaceId: string,
  current: ManifestationBudgetConfig
): Promise<ManifestationBudgetConfig> {
  const result = await apiFetch<PatchResult>(`/config/${workspaceId}/manifestation-budget`, {
    method: "PATCH",
    body: current
  });
  return result.data ?? current;
}

function patchRoot(
  current: ManifestationBudgetConfig | null,
  patch: Partial<ManifestationBudgetConfig>
): ManifestationBudgetConfig | null {
  return current === null ? current : { ...current, ...patch };
}

function patchEscalationPolicy(
  current: ManifestationBudgetConfig | null,
  patch: Partial<ManifestationBudgetConfig["escalation_policy"]>
): ManifestationBudgetConfig | null {
  if (current === null) return current;
  return {
    ...current,
    escalation_policy: { ...current.escalation_policy, ...patch }
  };
}

function isDirty(
  initial: ManifestationBudgetConfig | null,
  current: ManifestationBudgetConfig | null
): boolean {
  if (initial === null || current === null) return false;
  return JSON.stringify(initial) !== JSON.stringify(current);
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
