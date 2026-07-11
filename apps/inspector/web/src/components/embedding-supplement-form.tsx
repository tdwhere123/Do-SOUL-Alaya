import { AlertTriangle, Save } from "lucide-react";
import type { EmbeddingStatus } from "@do-soul/alaya-protocol";
import { useToasts } from "./toast";
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
  const state = useEmbeddingSupplementState({ onRequiresRestart, showToast, workspaceId });
  if (state.loading) {
    return <LoadingConfig label="Loading Embedding Supplement..." />;
  }
  return <EmbeddingSupplementEditor state={state} />;
}

function EmbeddingSupplementEditor(props: {
  readonly state: ReturnType<typeof useEmbeddingSupplementState>;
}) {
  const { state } = props;
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
        label="Commit Embedding"
        onSave={state.handleSave}
      />
    </div>
  );
}

function EmbeddingPrimaryFields(props: {
  readonly fields: EmbeddingFormFields;
  readonly setField: <K extends keyof EmbeddingFormFields>(key: K, value: EmbeddingFormFields[K]) => void;
}) {
  return (
    <>
      <FieldRow label="provider url">
        <ConfigTextInput
          value={props.fields.providerUrl}
          onChange={(value) => props.setField("providerUrl", value)}
          placeholder="https://api.openai.com/v1"
        />
      </FieldRow>
      <FieldRow label="model id">
        <ConfigTextInput
          value={props.fields.modelId}
          onChange={(value) => props.setField("modelId", value)}
          placeholder="text-embedding-3-small"
        />
      </FieldRow>
      <FieldRow label="embedding enabled">
        <ToggleSwitch
          enabled={props.fields.embeddingEnabled}
          label="Toggle embedding"
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
  return (
    <FieldRow label="secret ref">
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
  return (
    <div className="pt-4 flex items-center justify-between">
      <span className="text-[10px] text-ink-700/40 uppercase tracking-widest">
        {props.dirty ? "unsaved changes" : "in sync with daemon"}
      </span>
      <button
        onClick={() => void props.onSave()}
        disabled={props.saving || !props.dirty || props.validationError !== null}
        className="flex items-center gap-2 px-4 py-2 bg-ink-600 text-beige-50 rounded text-xs font-bold uppercase tracking-widest hover:bg-ink-700 disabled:opacity-40 transition-colors"
      >
        {props.saving ? "Saving..." : <><Save className="w-4 h-4" />{props.label}</>}
      </button>
    </div>
  );
}

function EmbeddingStatusAlert({ status }: { readonly status: EmbeddingStatus | null }) {
  if (status === null || status.effective_mode !== "degraded") return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 px-4 py-3 bg-morandi-pink/15 border border-morandi-pink rounded text-xs text-ink-700"
    >
      <AlertTriangle className="w-4 h-4 mt-0.5 text-morandi-pink shrink-0" />
      <div className="flex-1 space-y-1 min-w-0">
        <p className="font-bold uppercase tracking-widest">Embedding Degraded</p>
        <p className="text-ink-700/80 break-words">
          {humanizeDegradedReason(status.degraded_reason)}
        </p>
        <p className="text-[10px] text-ink-700/50 font-mono">checked {status.checked_at}</p>
      </div>
    </div>
  );
}

function humanizeDegradedReason(reason: string | null): string {
  if (reason === null || reason === "") {
    return "Embedding marked degraded but no reason was reported. Check daemon logs.";
  }
  switch (reason) {
    case "provider_unconfigured":
      return "Provider is not configured. Set the secret_ref and re-save, then restart the daemon.";
    case "storage_unavailable":
      return "Embedding storage table is missing. Run `alaya doctor` to verify schema migration.";
    case "provider_unavailable":
      return "Provider rejected our request (auth or network). Verify the secret_ref points to a valid key and the provider URL is reachable.";
    case "query_embedding_failed":
      return "Provider returned an error when embedding a query. Verify the model id is supported by your endpoint.";
    case "local_vector_lookup_failed":
      return "Local embedding vector lookup failed. Restart the daemon; if it persists, run `alaya doctor`.";
    default:
      return `Provider reports: ${reason}. See daemon logs for the full error.`;
  }
}
