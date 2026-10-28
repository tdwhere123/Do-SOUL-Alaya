import { useEffect, useState } from "react";
import {
  EmbeddingStatusSchema,
  type EmbeddingStatus,
  type RuntimeEmbeddingConfig
} from "@do-soul/alaya-protocol";
import { apiFetch, type ApiError } from "../api";
import { useToasts } from "./toast";

interface EmbeddingStatusEnvelope {
  readonly data?: unknown;
}

export interface EmbeddingSupplementState {
  readonly embeddingStatus: EmbeddingStatus | null;
  readonly config: RuntimeEmbeddingConfig | null;
  readonly loading: boolean;
  readonly configError: string | null;
  readonly statusError: string | null;
}

export function useEmbeddingSupplementState(workspaceId: string): EmbeddingSupplementState {
  const { showToast } = useToasts();
  const [config, setConfig] = useState<RuntimeEmbeddingConfig | null>(null);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setConfig(null);
    setEmbeddingStatus(null);
    setConfigError(null);
    setStatusError(null);
    void loadEmbeddingSupplement(workspaceId, showToast, () => cancelled, setConfig, setEmbeddingStatus, setConfigError, setStatusError)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showToast, workspaceId]);

  return { config, embeddingStatus, loading, configError, statusError };
}

async function loadEmbeddingSupplement(
  workspaceId: string,
  showToast: ReturnType<typeof useToasts>["showToast"],
  isCancelled: () => boolean,
  setConfig: (config: RuntimeEmbeddingConfig) => void,
  setEmbeddingStatus: (status: EmbeddingStatus | null) => void,
  setConfigError: (message: string) => void,
  setStatusError: (message: string) => void
): Promise<void> {
  try {
    const config = await apiFetch<RuntimeEmbeddingConfig>(
      `/config/${workspaceId}/embedding-supplement`
    );
    if (isCancelled()) return;
    setConfig(config);
  } catch (err) {
    if (!isCancelled() && (err as ApiError).status !== 401) {
      setConfigError(err instanceof Error ? err.message : String(err));
      showToast({
        message: `Failed to load embedding config: ${(err as Error).message}`,
        type: "error"
      });
    }
    return;
  }
  try {
    const envelope = await apiFetch<EmbeddingStatusEnvelope>(`/embedding-status/${workspaceId}`);
    const status = EmbeddingStatusSchema.parse(envelope.data);
    if (!isCancelled()) setEmbeddingStatus(status);
  } catch (err) {
    if (!isCancelled() && (err as ApiError).status !== 401) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  }
}
