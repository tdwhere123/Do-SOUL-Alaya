import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  EmbeddingStatusSchema,
  type EmbeddingStatus,
  type RuntimeEmbeddingConfig
} from "@do-soul/alaya-protocol";
import { apiFetch, type ApiError } from "../api";
import type { ToastInput } from "./toast";
import {
  buildSecretPatch,
  buildSecretRef,
  parseSecretRef,
  validateSecretValue,
  type SecretRefMode
} from "./config-form-fields";

type ShowToast = (input: ToastInput) => void;

interface PatchResult {
  readonly success?: boolean;
  readonly requires_daemon_restart?: boolean;
  readonly data?: unknown;
}

interface RuntimeEmbeddingConfigEnvelope {
  readonly success?: boolean;
  readonly data?: RuntimeEmbeddingConfig;
}

export interface EmbeddingFormFields {
  readonly providerUrl: string;
  readonly modelId: string;
  readonly embeddingEnabled: boolean;
  readonly secretMode: SecretRefMode;
  readonly secretValue: string;
}

export interface EmbeddingSupplementState {
  readonly dirty: boolean;
  readonly embeddingStatus: EmbeddingStatus | null;
  readonly fields: EmbeddingFormFields;
  readonly loading: boolean;
  readonly revealFile: boolean;
  readonly saving: boolean;
  readonly validationError: string | null;
  readonly handleSave: () => Promise<void>;
  readonly setFields: Dispatch<SetStateAction<EmbeddingFormFields>>;
  readonly setRevealFile: Dispatch<SetStateAction<boolean>>;
  readonly setValidationError: Dispatch<SetStateAction<string | null>>;
}

export function useEmbeddingSupplementState(props: {
  readonly onRequiresRestart: () => void;
  readonly showToast: ShowToast;
  readonly workspaceId: string;
}): EmbeddingSupplementState {
  const { onRequiresRestart, showToast, workspaceId } = props;
  const [fields, setFields] = useState<EmbeddingFormFields>(emptyEmbeddingFields);
  const [revealFile, setRevealFile] = useState(false);
  const [initial, setInitial] = useState<RuntimeEmbeddingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);
  const fieldsRevisionRef = useRef(0);
  const updateFields = useCallback((next: SetStateAction<EmbeddingFormFields>) => {
    fieldsRevisionRef.current += 1;
    setFields(next);
  }, []);
  const refreshEmbeddingStatus = useEmbeddingStatusRefresh(workspaceId, setEmbeddingStatus);

  useEffect(() => {
    return loadEmbeddingConfig({ workspaceId, showToast, refreshEmbeddingStatus, setFields: updateFields, setInitial, setLoading });
  }, [refreshEmbeddingStatus, showToast, updateFields, workspaceId]);

  const dirty = useMemo(() => isEmbeddingDirty(initial, fields), [fields, initial]);
  const handleSave = useCallback(
    () =>
      saveEmbeddingConfig({
        fields,
        fieldsRevisionRef,
        onRequiresRestart,
        showToast,
        setFields,
        setInitial,
        setSaving,
        setValidationError
      }),
    [fields, onRequiresRestart, showToast]
  );

  return {
    dirty,
    embeddingStatus,
    fields,
    handleSave,
    loading,
    revealFile,
    saving,
    setFields: updateFields,
    setRevealFile,
    setValidationError,
    validationError
  };
}

function useEmbeddingStatusRefresh(
  workspaceId: string,
  setEmbeddingStatus: (status: EmbeddingStatus | null) => void
) {
  return useCallback(async (isCancelled: () => boolean = () => false) => {
    try {
      const envelope = await apiFetch<{ data?: unknown }>(`/embedding-status/${workspaceId}`);
      const parsed = EmbeddingStatusSchema.safeParse(envelope.data);
      if (!isCancelled() && parsed.success) setEmbeddingStatus(parsed.data);
    } catch {
      if (!isCancelled()) setEmbeddingStatus(null);
    }
  }, [setEmbeddingStatus, workspaceId]);
}

function loadEmbeddingConfig(props: {
  readonly workspaceId: string;
  readonly showToast: ShowToast;
  readonly refreshEmbeddingStatus: (isCancelled?: () => boolean) => Promise<void>;
  readonly setFields: Dispatch<SetStateAction<EmbeddingFormFields>>;
  readonly setInitial: (config: RuntimeEmbeddingConfig | null) => void;
  readonly setLoading: (loading: boolean) => void;
}) {
  let cancelled = false;
  void (async () => {
    try {
      const data = await fetchRuntimeEmbeddingConfig(props.workspaceId);
      if (cancelled) return;
      props.setInitial(data);
      props.setFields(fieldsFromEmbeddingConfig(data));
    } catch (err) {
      if (!cancelled && (err as ApiError).status !== 401) {
        props.showToast({ message: `Failed to load embedding config: ${(err as Error).message}`, type: "error" });
      }
      return;
    } finally {
      if (!cancelled) props.setLoading(false);
    }
    if (!cancelled) await props.refreshEmbeddingStatus(() => cancelled);
  })();
  return () => {
    cancelled = true;
  };
}

async function saveEmbeddingConfig(props: {
  readonly fields: EmbeddingFormFields;
  readonly fieldsRevisionRef: MutableRefObject<number>;
  readonly onRequiresRestart: () => void;
  readonly showToast: ShowToast;
  readonly setFields: Dispatch<SetStateAction<EmbeddingFormFields>>;
  readonly setInitial: (config: RuntimeEmbeddingConfig | null) => void;
  readonly setSaving: (saving: boolean) => void;
  readonly setValidationError: (error: string | null) => void;
}) {
  const validation = props.fields.secretValue === ""
    ? null
    : validateSecretValue(props.fields.secretMode, props.fields.secretValue);
  if (validation) {
    props.setValidationError(validation);
    return;
  }
  props.setValidationError(null);
  props.setSaving(true);
  const fieldsRevision = props.fieldsRevisionRef.current;
  try {
    await patchRuntimeEmbeddingConfig({ ...props, fieldsRevision });
  } catch (err) {
    if ((err as ApiError).status !== 401) {
      props.showToast({ message: `Failed to patch embedding: ${(err as Error).message}`, type: "error" });
    }
  } finally {
    props.setSaving(false);
  }
}

async function patchRuntimeEmbeddingConfig(props: {
  readonly fields: EmbeddingFormFields;
  readonly fieldsRevision: number;
  readonly fieldsRevisionRef: MutableRefObject<number>;
  readonly onRequiresRestart: () => void;
  readonly showToast: ShowToast;
  readonly setFields: Dispatch<SetStateAction<EmbeddingFormFields>>;
  readonly setInitial: (config: RuntimeEmbeddingConfig | null) => void;
}) {
  const secretPatch = buildSecretPatch(props.fields.secretMode, props.fields.secretValue);
  const result = await apiFetch<PatchResult>("/config/runtime/embedding-supplement", {
    method: "PATCH",
    body: {
      provider_url: props.fields.providerUrl === "" ? null : props.fields.providerUrl,
      model_id: props.fields.modelId === "" ? null : props.fields.modelId,
      embedding_enabled: props.fields.embeddingEnabled,
      ...secretPatch
    }
  });
  const sanitized = unwrapRuntimeEmbeddingConfig(result.data);
  props.showToast({ message: "Embedding supplement patched · daemon restart pending", type: "success" });
  if (result.requires_daemon_restart) props.onRequiresRestart();
  const nextInitial = nextEmbeddingInitial(props.fields, secretPatch.secret_ref ?? null, sanitized);
  props.setInitial(nextInitial);
  if (props.fieldsRevisionRef.current === props.fieldsRevision) {
    props.setFields(fieldsFromEmbeddingConfig(nextInitial));
  }
}

async function fetchRuntimeEmbeddingConfig(workspaceId: string): Promise<RuntimeEmbeddingConfig> {
  const envelope = await apiFetch<RuntimeEmbeddingConfig | RuntimeEmbeddingConfigEnvelope>(
    `/config/${workspaceId}/embedding-supplement`
  );
  return unwrapRuntimeEmbeddingConfig(envelope);
}

function fieldsFromEmbeddingConfig(config: RuntimeEmbeddingConfig): EmbeddingFormFields {
  const parsed = parseSecretRef(config.secret_ref);
  return {
    providerUrl: config.provider_url ?? "",
    modelId: config.model_id ?? "",
    embeddingEnabled: config.embedding_enabled,
    secretMode: parsed.mode,
    secretValue: parsed.value
  };
}

function isEmbeddingDirty(initial: RuntimeEmbeddingConfig | null, fields: EmbeddingFormFields): boolean {
  if (!initial) return false;
  const builtRef = fields.secretMode === "paste" ? initial.secret_ref : buildSecretRef(fields.secretMode, fields.secretValue);
  return (
    (initial.provider_url ?? "") !== fields.providerUrl ||
    (initial.model_id ?? "") !== fields.modelId ||
    initial.embedding_enabled !== fields.embeddingEnabled ||
    (fields.secretMode === "paste" ? fields.secretValue !== "" : (initial.secret_ref ?? null) !== builtRef)
  );
}

function nextEmbeddingInitial(
  fields: EmbeddingFormFields,
  requestedSecretRef: string | null,
  sanitized: RuntimeEmbeddingConfig
): RuntimeEmbeddingConfig {
  return {
    provider_url: sanitized?.provider_url ?? (fields.providerUrl === "" ? null : fields.providerUrl),
    model_id: sanitized?.model_id ?? (fields.modelId === "" ? null : fields.modelId),
    embedding_enabled: sanitized?.embedding_enabled ?? fields.embeddingEnabled,
    secret_ref: sanitized?.secret_ref ?? requestedSecretRef
  };
}

function unwrapRuntimeEmbeddingConfig(value: unknown): RuntimeEmbeddingConfig {
  if (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof (value as RuntimeEmbeddingConfigEnvelope).data === "object"
  ) {
    return (value as RuntimeEmbeddingConfigEnvelope).data as RuntimeEmbeddingConfig;
  }
  return value as RuntimeEmbeddingConfig;
}

function emptyEmbeddingFields(): EmbeddingFormFields {
  return {
    providerUrl: "",
    modelId: "",
    embeddingEnabled: false,
    secretMode: "env",
    secretValue: ""
  };
}
