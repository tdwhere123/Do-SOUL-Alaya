import { AlertTriangle } from "lucide-react";
import type { EmbeddingStatus } from "@do-soul/alaya-protocol";
import { useI18n } from "../i18n/locale";
import {
  ReadOnlyFieldRow,
  RuntimeConfigReadOnlyNotice,
  formatSecretRef
} from "./config-form-fields";
import { useEmbeddingSupplementState } from "./embedding-supplement-state";

interface Props {
  readonly workspaceId: string;
}

export default function EmbeddingSupplementForm({ workspaceId }: Props) {
  const { t } = useI18n();
  const state = useEmbeddingSupplementState(workspaceId);
  if (state.loading) {
    return <LoadingConfig label={t("config:loading.embeddingSupplement")} />;
  }
  if (state.config === null) return null;
  return (
    <div className="space-y-5">
      <EmbeddingStatusAlert status={state.embeddingStatus} />
      <RuntimeConfigReadOnlyNotice />
      <ReadOnlyFieldRow label={t("config:field.providerUrl")} value={state.config.provider_url} />
      <ReadOnlyFieldRow label={t("config:field.modelId")} value={state.config.model_id} />
      <ReadOnlyFieldRow label={t("config:field.embeddingEnabled")} value={state.config.embedding_enabled} />
      <ReadOnlyFieldRow label={t("config:field.secretRef")} value={formatSecretRef(state.config.secret_ref)} />
    </div>
  );
}

export function LoadingConfig({ label }: { readonly label: string }) {
  return (
    <div className="py-4 text-xs text-ink-700/40 uppercase tracking-widest animate-pulse">
      {label}
    </div>
  );
}

function EmbeddingStatusAlert({ status }: { readonly status: EmbeddingStatus | null }) {
  const { t } = useI18n();
  if (status === null || status.effective_mode !== "degraded") return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 px-4 py-3 bg-morandi-pink/15 border border-morandi-pink rounded text-xs text-ink-700"
    >
      <AlertTriangle className="w-4 h-4 mt-0.5 text-morandi-pink shrink-0" />
      <div className="flex-1 space-y-1 min-w-0">
        <p className="font-bold uppercase tracking-widest">{t("config:embedding.degraded.heading")}</p>
        <p className="text-ink-700/80 break-words">
          {humanizeDegradedReason(status.degraded_reason, t)}
        </p>
        <p className="text-[10px] text-ink-700/50 font-mono">
          {t("config:embedding.degraded.checked", { timestamp: status.checked_at })}
        </p>
      </div>
    </div>
  );
}

function humanizeDegradedReason(reason: string | null, t: ReturnType<typeof useI18n>["t"]): string {
  if (reason === null || reason === "") {
    return t("config:embedding.degraded.reason.none");
  }
  switch (reason) {
    case "provider_unconfigured":
      return t("config:embedding.degraded.reason.providerUnconfigured");
    case "storage_unavailable":
      return t("config:embedding.degraded.reason.storageUnavailable");
    case "provider_unavailable":
      return t("config:embedding.degraded.reason.providerUnavailable");
    case "query_embedding_failed":
      return t("config:embedding.degraded.reason.queryEmbeddingFailed");
    case "local_vector_lookup_failed":
      return t("config:embedding.degraded.reason.localVectorLookupFailed");
    default:
      return t("config:embedding.degraded.reason.unknown", { reason });
  }
}
