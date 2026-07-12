import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { RuntimeGardenComputeConfig } from "@do-soul/alaya-protocol";
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
type ProviderKind = RuntimeGardenComputeConfig["provider_kind"];

interface PatchResult {
  readonly success?: boolean;
  readonly requires_daemon_restart?: boolean;
  readonly data?: unknown;
}

interface RuntimeGardenComputeConfigEnvelope {
  readonly success?: boolean;
  readonly data?: RuntimeGardenComputeConfig;
}

export interface GardenComputeFields {
  readonly providerKind: ProviderKind;
  readonly providerUrl: string;
  readonly modelId: string;
  readonly enabled: boolean;
  readonly secretMode: SecretRefMode;
  readonly secretValue: string;
}

export interface GardenComputeState {
  readonly dirty: boolean;
  readonly fields: GardenComputeFields;
  readonly loading: boolean;
  readonly revealFile: boolean;
  readonly saving: boolean;
  readonly validationError: string | null;
  readonly handleSave: () => Promise<void>;
  readonly setFields: Dispatch<SetStateAction<GardenComputeFields>>;
  readonly setRevealFile: Dispatch<SetStateAction<boolean>>;
  readonly setValidationError: Dispatch<SetStateAction<string | null>>;
}

export function useGardenComputeState(props: {
  readonly onRequiresRestart: () => void;
  readonly showToast: ShowToast;
  readonly workspaceId: string;
}): GardenComputeState {
  const { onRequiresRestart, showToast, workspaceId } = props;
  const [fields, setFields] = useState<GardenComputeFields>(emptyGardenFields);
  const [revealFile, setRevealFile] = useState(false);
  const [initial, setInitial] = useState<RuntimeGardenComputeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const fieldsRevisionRef = useRef(0);
  const updateFields = useCallback((next: SetStateAction<GardenComputeFields>) => {
    fieldsRevisionRef.current += 1;
    setFields(next);
  }, []);

  useEffect(() => {
    return loadGardenCompute({ workspaceId, showToast, setFields: updateFields, setInitial, setLoading });
  }, [showToast, updateFields, workspaceId]);

  const dirty = useMemo(() => isGardenDirty(initial, fields), [fields, initial]);
  const handleSave = useCallback(
    () =>
      saveGardenCompute({
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

  return { dirty, fields, handleSave, loading, revealFile, saving, setFields: updateFields, setRevealFile, setValidationError, validationError };
}

function loadGardenCompute(props: {
  readonly workspaceId: string;
  readonly showToast: ShowToast;
  readonly setFields: Dispatch<SetStateAction<GardenComputeFields>>;
  readonly setInitial: (config: RuntimeGardenComputeConfig | null) => void;
  readonly setLoading: (loading: boolean) => void;
}) {
  let cancelled = false;
  void (async () => {
    try {
      const data = await fetchGardenConfig(props.workspaceId);
      if (cancelled) return;
      props.setInitial(data);
      props.setFields(fieldsFromGardenConfig(data));
    } catch (err) {
      if (!cancelled && (err as ApiError).status !== 401) {
        props.showToast({ message: `Failed to load garden compute config: ${(err as Error).message}`, type: "error" });
      }
    } finally {
      if (!cancelled) props.setLoading(false);
    }
  })();
  return () => {
    cancelled = true;
  };
}

async function saveGardenCompute(props: {
  readonly fields: GardenComputeFields;
  readonly fieldsRevisionRef: MutableRefObject<number>;
  readonly onRequiresRestart: () => void;
  readonly showToast: ShowToast;
  readonly setFields: Dispatch<SetStateAction<GardenComputeFields>>;
  readonly setInitial: (config: RuntimeGardenComputeConfig | null) => void;
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
    await patchGardenCompute({ ...props, fieldsRevision });
  } catch (err) {
    if ((err as ApiError).status !== 401) {
      props.showToast({ message: `Failed to patch garden compute: ${(err as Error).message}`, type: "error" });
    }
  } finally {
    props.setSaving(false);
  }
}

async function patchGardenCompute(props: {
  readonly fields: GardenComputeFields;
  readonly fieldsRevision: number;
  readonly fieldsRevisionRef: MutableRefObject<number>;
  readonly onRequiresRestart: () => void;
  readonly showToast: ShowToast;
  readonly setFields: Dispatch<SetStateAction<GardenComputeFields>>;
  readonly setInitial: (config: RuntimeGardenComputeConfig | null) => void;
}) {
  const secretPatch = buildSecretPatch(props.fields.secretMode, props.fields.secretValue);
  const result = await apiFetch<PatchResult>("/config/runtime/garden-compute", {
    method: "PATCH",
    body: {
      provider_kind: props.fields.providerKind,
      provider_url: props.fields.providerUrl === "" ? null : props.fields.providerUrl,
      model_id: props.fields.modelId === "" ? null : props.fields.modelId,
      enabled: props.fields.enabled,
      ...secretPatch
    }
  });
  const sanitized = unwrapRuntimeGardenComputeConfig(result.data);
  props.showToast({ message: "Garden compute patched · daemon restart pending", type: "success" });
  if (result.requires_daemon_restart) props.onRequiresRestart();
  const nextInitial = nextGardenInitial(props.fields, secretPatch.secret_ref ?? null, sanitized);
  props.setInitial(nextInitial);
  if (props.fieldsRevisionRef.current === props.fieldsRevision) {
    props.setFields(fieldsFromGardenConfig(nextInitial));
  }
}

async function fetchGardenConfig(workspaceId: string): Promise<RuntimeGardenComputeConfig> {
  const envelope = await apiFetch<RuntimeGardenComputeConfig | RuntimeGardenComputeConfigEnvelope>(
    `/config/${workspaceId}/garden-compute`
  );
  return unwrapRuntimeGardenComputeConfig(envelope);
}

function fieldsFromGardenConfig(config: RuntimeGardenComputeConfig): GardenComputeFields {
  const parsed = parseSecretRef(config.secret_ref);
  return {
    providerKind: config.provider_kind,
    providerUrl: config.provider_url ?? "",
    modelId: config.model_id ?? "",
    enabled: config.enabled,
    secretMode: parsed.mode,
    secretValue: parsed.value
  };
}

function isGardenDirty(initial: RuntimeGardenComputeConfig | null, fields: GardenComputeFields): boolean {
  if (!initial) return false;
  const builtRef = fields.secretMode === "paste" ? initial.secret_ref : buildSecretRef(fields.secretMode, fields.secretValue);
  return (
    initial.provider_kind !== fields.providerKind ||
    (initial.provider_url ?? "") !== fields.providerUrl ||
    (initial.model_id ?? "") !== fields.modelId ||
    initial.enabled !== fields.enabled ||
    (fields.secretMode === "paste" ? fields.secretValue !== "" : (initial.secret_ref ?? null) !== builtRef)
  );
}

function nextGardenInitial(
  fields: GardenComputeFields,
  requestedSecretRef: string | null,
  sanitized: RuntimeGardenComputeConfig
): RuntimeGardenComputeConfig {
  return {
    provider_kind: sanitized?.provider_kind ?? fields.providerKind,
    provider_url: sanitized?.provider_url ?? (fields.providerUrl === "" ? null : fields.providerUrl),
    model_id: sanitized?.model_id ?? (fields.modelId === "" ? null : fields.modelId),
    enabled: sanitized?.enabled ?? fields.enabled,
    secret_ref: sanitized?.secret_ref ?? requestedSecretRef
  };
}

function unwrapRuntimeGardenComputeConfig(value: unknown): RuntimeGardenComputeConfig {
  if (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof (value as RuntimeGardenComputeConfigEnvelope).data === "object"
  ) {
    return (value as RuntimeGardenComputeConfigEnvelope).data as RuntimeGardenComputeConfig;
  }
  return value as RuntimeGardenComputeConfig;
}

function emptyGardenFields(): GardenComputeFields {
  return {
    providerKind: "local_heuristics",
    providerUrl: "",
    modelId: "",
    enabled: false,
    secretMode: "env",
    secretValue: ""
  };
}
