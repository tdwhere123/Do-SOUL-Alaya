import { useToasts } from "./toast";
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
  const state = useGardenComputeState({ onRequiresRestart, showToast, workspaceId });
  if (state.loading) {
    return <LoadingConfig label="Loading Garden Compute..." />;
  }
  return <GardenComputeEditor state={state} />;
}

function GardenComputeEditor(props: { readonly state: ReturnType<typeof useGardenComputeState> }) {
  const { state } = props;
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
        label="Commit Garden Compute"
        onSave={state.handleSave}
      />
    </div>
  );
}

function GardenPrimaryFields(props: {
  readonly fields: GardenComputeFields;
  readonly setField: <K extends keyof GardenComputeFields>(key: K, value: GardenComputeFields[K]) => void;
}) {
  return (
    <>
      <FieldRow label="provider kind">
        <ProviderKindSelect
          value={props.fields.providerKind}
          onChange={(value) => props.setField("providerKind", value)}
        />
      </FieldRow>
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
          placeholder="gpt-4.1-mini"
        />
      </FieldRow>
      <FieldRow label="garden compute enabled">
        <ToggleSwitch
          enabled={props.fields.enabled}
          label="Toggle garden compute"
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

function ProviderKindSelect(props: {
  readonly value: GardenComputeFields["providerKind"];
  readonly onChange: (value: GardenComputeFields["providerKind"]) => void;
}) {
  return (
    <select
      value={props.value}
      onChange={(event) => props.onChange(event.target.value as GardenComputeFields["providerKind"])}
      className="bg-transparent border-b border-beige-300 focus:border-ink-600 outline-none text-sm text-ink-700 font-mono text-right py-1 min-w-[260px]"
      aria-label="Garden compute provider kind"
    >
      <option value="local_heuristics">local_heuristics (no external calls)</option>
      <option value="official_api">official_api (OpenAI-compatible)</option>
      <option value="host_worker">host_worker (attached CLI agent claims via MCP)</option>
    </select>
  );
}
