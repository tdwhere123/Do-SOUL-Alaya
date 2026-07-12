import { AlertTriangle, Save } from "lucide-react";
import type { EmbeddingStatus } from "@do-soul/alaya-protocol";
import { useToasts } from "./toast";
import { useI18n } from "../i18n/locale";
import {
  FieldRow,
  SecretRefField,
  ToggleSwitch,
  type SecretRefMode
} from "./config-form-fields";
import {
  useEmbeddingSupplementState,
  type EmbeddingFormFields
} from "./embedding-supplement-state";

interface Props {
  readonly onRequiresRestart: () => void;
  readonly workspaceId: string;
}

export default function EmbeddingSupplementForm({ onRequiresRestart, workspaceId }: Props) {
  const { showToast } = useToasts();
  const { t } = useI18n();
  const state = useEmbeddingSupplementState({ onRequiresRestart, showToast, workspaceId });
  if (state.loading) {
    return <LoadingConfig label={t("config:loading.embeddingSupplement")} />;
  }
  return <EmbeddingSupplementEditor state={state} />;
}

function EmbeddingSupplementEditor(props: {
  readonly state: ReturnType<typeof useEmbeddingSupplementState>;
}) {
  const { state } = props;
  const { t } = useI18n();
  const setField = <K extends keyof EmbeddingFormFields>(key: K, value: EmbeddingFormFields[K]) =>
    state.setFields((current) => ({ ...current, [key]: value }));

  return (
    <div className="space-y-5">
      <EmbeddingStatusAlert status={state.embeddingStatus} />
      <EmbeddingPrimaryFields fields={state.fields} setField={setField} />
      <EmbeddingSecretField state={state} setField={setField} />
      <CommitConfigRow
        dirty={state.dirty}
        saving={state.saving}
        validationError={state.validationError}
        label={t("config:action.commitEmbedding")}
        onSave={state.handleSave}
      />
    </div>
  );
}

function EmbeddingPrimaryFields(props: {
  readonly fields: EmbeddingFormFields;
  readonly setField: <K extends keyof EmbeddingFormFields>(key: K, value: EmbeddingFormFields[K]) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <FieldRow label={t("config:field.providerUrl")}>
        <ConfigTextInput
          value={props.fields.providerUrl}
          onChange={(value) => props.setField("providerUrl", value)}
          placeholder="https://api.openai.com/v1"
        />
      </FieldRow>
      <FieldRow label={t("config:field.modelId")}>
        <ConfigTextInput
          value={props.fields.modelId}
          onChange={(value) => props.setField("modelId", value)}
          placeholder="text-embedding-3-small"
        />
      </FieldRow>
      <FieldRow label={t("config:field.embeddingEnabled")}>
        <ToggleSwitch
          enabled={props.fields.embeddingEnabled}
          label={t("config:field.toggle", { field: t("config:field.embeddingEnabled") })}
          onToggle={() => props.setField("embeddingEnabled", !props.fields.embeddingEnabled)}
        />
      </FieldRow>
    </>
  );
}

function EmbeddingSecretField(props: {
  readonly state: ReturnType<typeof useEmbeddingSupplementState>;
  readonly setField: <K extends keyof EmbeddingFormFields>(key: K, value: EmbeddingFormFields[K]) => void;
}) {
  const { t } = useI18n();
  return (
    <FieldRow label={t("config:field.secretRef")}>
      <SecretRefField
        mode={props.state.fields.secretMode}
        value={props.state.fields.secretValue}
        revealFile={props.state.revealFile}
        validationError={props.state.validationError}
        onModeChange={(mode: SecretRefMode) => props.setField("secretMode", mode)}
        onRevealFileChange={props.state.setRevealFile}
        onValidationErrorChange={props.state.setValidationError}
        onValueChange={(value) => props.setField("secretValue", value)}
      />
    </FieldRow>
  );
}

export function ConfigTextInput(props: {
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <input
      type="text"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
      className="bg-transparent border-b border-beige-300 focus:border-ink-600 outline-none text-sm text-ink-700 font-mono text-right py-1 min-w-[260px]"
    />
  );
}

export function LoadingConfig({ label }: { readonly label: string }) {
  return (
    <div className="py-4 text-xs text-ink-700/40 uppercase tracking-widest animate-pulse">
      {label}
    </div>
  );
}

export function CommitConfigRow(props: {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly validationError: string | null;
  readonly label: string;
  readonly onSave: () => Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <div className="pt-4 flex items-center justify-between">
      <span className="text-[10px] text-ink-700/40 uppercase tracking-widest">
        {props.dirty ? t("config:dirty.unsaved") : t("config:dirty.synced")}
      </span>
      <button
        onClick={() => void props.onSave()}
        disabled={props.saving || !props.dirty || props.validationError !== null}
        className="flex items-center gap-2 px-4 py-2 bg-ink-600 text-beige-50 rounded text-xs font-bold uppercase tracking-widest hover:bg-ink-700 disabled:opacity-40 transition-colors"
      >
        {props.saving ? t("config:action.saving") : <><Save className="w-4 h-4" />{props.label}</>}
      </button>
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
