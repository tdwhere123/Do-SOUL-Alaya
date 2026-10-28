import { useEffect, useState } from "react";
import type { RuntimeGardenComputeConfig } from "@do-soul/alaya-protocol";
import { apiFetch, type ApiError } from "../api";
import { useToasts } from "./toast";

export interface GardenComputeState {
  readonly config: RuntimeGardenComputeConfig | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export function useGardenComputeState(workspaceId: string): GardenComputeState {
  const { showToast } = useToasts();
  const [config, setConfig] = useState<RuntimeGardenComputeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setConfig(null);
    setError(null);
    void (async () => {
      try {
        const loaded = await apiFetch<RuntimeGardenComputeConfig>(
          `/config/${workspaceId}/garden-compute`
        );
        if (!cancelled) setConfig(loaded);
      } catch (err) {
        if (!cancelled && (err as ApiError).status !== 401) {
          setError(err instanceof Error ? err.message : String(err));
          showToast({
            message: `Failed to load garden compute config: ${(err as Error).message}`,
            type: "error"
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showToast, workspaceId]);

  return { config, loading, error };
}
