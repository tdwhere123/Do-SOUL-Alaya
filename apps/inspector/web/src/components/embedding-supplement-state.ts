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
}

export function useEmbeddingSupplementState(workspaceId: string): EmbeddingSupplementState {
  const { showToast } = useToasts();
  const [config, setConfig] = useState<RuntimeEmbeddingConfig | null>(null);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadEmbeddingSupplement(workspaceId, showToast, () => cancelled, setConfig, setEmbeddingStatus)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showToast, workspaceId]);

  return { config, embeddingStatus, loading };
}

async function loadEmbeddingSupplement(
  workspaceId: string,
  showToast: ReturnType<typeof useToasts>["showToast"],
  isCancelled: () => boolean,
  setConfig: (config: RuntimeEmbeddingConfig) => void,
  setEmbeddingStatus: (status: EmbeddingStatus | null) => void
): Promise<void> {
  try {
    const config = await apiFetch<RuntimeEmbeddingConfig>(
      `/config/${workspaceId}/embedding-supplement`
    );
    if (isCancelled()) return;
    setConfig(config);
  } catch (err) {
    if (!isCancelled() && (err as ApiError).status !== 401) {
      showToast({
        message: `Failed to load embedding config: ${(err as Error).message}`,
        type: "error"
      });
    }
    return;
  }
  const status = await fetchEmbeddingStatus(workspaceId);
  if (!isCancelled()) setEmbeddingStatus(status);
}

async function fetchEmbeddingStatus(workspaceId: string): Promise<EmbeddingStatus | null> {
  try {
    const envelope = await apiFetch<EmbeddingStatusEnvelope>(`/embedding-status/${workspaceId}`);
    const parsed = EmbeddingStatusSchema.safeParse(envelope.data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
