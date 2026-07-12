import { useToasts } from "./toast";
import { useI18n } from "../i18n/locale";
import {
  FieldRow,
  SecretRefField,
  ToggleSwitch,
  type SecretRefMode
} from "./config-form-fields";
import {
  CommitConfigRow,
  ConfigTextInput,
  LoadingConfig
} from "./embedding-supplement-form";
import {
  useGardenComputeState,
  type GardenComputeFields
} from "./garden-compute-state";

interface Props {
  readonly onRequiresRestart: () => void;
  readonly workspaceId: string;
}

export default function GardenComputeForm({ onRequiresRestart, workspaceId }: Props) {
  const { showToast } = useToasts();
  const { t } = useI18n();
  const state = useGardenComputeState({ onRequiresRestart, showToast, workspaceId });
  if (state.loading) {
    return <LoadingConfig label={t("config:loading.gardenCompute")} />;
  }
  return <GardenComputeEditor state={state} />;
}

function GardenComputeEditor(props: { readonly state: ReturnType<typeof useGardenComputeState> }) {
  const { state } = props;
  const { t } = useI18n();
  const setField = <K extends keyof GardenComputeFields>(key: K, value: GardenComputeFields[K]) =>
    state.setFields((current) => ({ ...current, [key]: value }));

  return (
    <div className="space-y-5">
      <GardenPrimaryFields fields={state.fields} setField={setField} />
      <GardenSecretField state={state} setField={setField} />
      <CommitConfigRow
        dirty={state.dirty}
        saving={state.saving}
        validationError={state.validationError}
        label={t("config:action.commitGardenCompute")}
        onSave={state.handleSave}
      />
    </div>
  );
}

function GardenPrimaryFields(props: {
  readonly fields: GardenComputeFields;
  readonly setField: <K extends keyof GardenComputeFields>(key: K, value: GardenComputeFields[K]) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <FieldRow label={t("config:field.providerKind")}>
        <ProviderKindSelect
          value={props.fields.providerKind}
          onChange={(value) => props.setField("providerKind", value)}
        />
      </FieldRow>
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
          placeholder="gpt-4.1-mini"
        />
      </FieldRow>
      <FieldRow label={t("config:field.gardenComputeEnabled")}>
        <ToggleSwitch
          enabled={props.fields.enabled}
          label={t("config:field.toggle", { field: t("config:field.gardenComputeEnabled") })}
          onToggle={() => props.setField("enabled", !props.fields.enabled)}
        />
      </FieldRow>
    </>
  );
}

function GardenSecretField(props: {
  readonly state: ReturnType<typeof useGardenComputeState>;
  readonly setField: <K extends keyof GardenComputeFields>(key: K, value: GardenComputeFields[K]) => void;
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

function ProviderKindSelect(props: {
  readonly value: GardenComputeFields["providerKind"];
  readonly onChange: (value: GardenComputeFields["providerKind"]) => void;
}) {
  const { t } = useI18n();
  return (
    <select
      value={props.value}
      onChange={(event) => props.onChange(event.target.value as GardenComputeFields["providerKind"])}
      className="bg-transparent border-b border-beige-300 focus:border-ink-600 outline-none text-sm text-ink-700 font-mono text-right py-1 min-w-[260px]"
      aria-label={t("config:field.providerKindAria")}
    >
      <option value="local_heuristics">local_heuristics ({t("config:provider.localHeuristics")})</option>
      <option value="official_api">official_api ({t("config:provider.officialApi")})</option>
      <option value="host_worker">host_worker ({t("config:provider.hostWorker")})</option>
    </select>
  );
}
