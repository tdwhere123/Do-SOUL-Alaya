import { Save } from "lucide-react";
import type { ManifestationBudgetConfig } from "@do-soul/alaya-protocol";
import { FieldRow, ToggleSwitch } from "./config-form-fields";
import { useI18n } from "../i18n/locale";
import {
  useManifestationBudgetState,
  type ManifestationBudgetState
} from "./manifestation-budget-state";

interface Props {
  readonly workspaceId: string;
}

export default function ManifestationBudgetForm({ workspaceId }: Props) {
  const state = useManifestationBudgetState(workspaceId);
  if (state.loading) return <LoadingBudget />;
  if (state.current === null) return null;
  return <ManifestationBudgetEditor state={state} />;
}

function ManifestationBudgetEditor(props: { readonly state: ManifestationBudgetState }) {
  const config = props.state.current;
  if (config === null) return null;
  return (
    <div className="space-y-5">
      <BudgetRootRows config={config} onChange={props.state.patchConfig} />
      <BudgetPolicyRows config={config} onChange={props.state.patchPolicy} />
      <BudgetCommitRow
        dirty={props.state.dirty}
        saving={props.state.saving}
        onSave={props.state.save}
      />
    </div>
  );
}

function BudgetRootRows(props: {
  readonly config: ManifestationBudgetConfig;
  readonly onChange: (patch: Partial<ManifestationBudgetConfig>) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <NumberRow label={t("config:budget.stanceBiasCap")} value={props.config.stance_bias_cap} onChange={(value) => props.onChange({ stance_bias_cap: value })} />
      <NumberRow label={t("config:budget.dialogueNudgeCap")} value={props.config.dialogue_nudge_cap} onChange={(value) => props.onChange({ dialogue_nudge_cap: value })} />
      <NumberRow label={t("config:budget.lensEntryCap")} value={props.config.lens_entry_cap} onChange={(value) => props.onChange({ lens_entry_cap: value })} />
    </>
  );
}

function BudgetPolicyRows(props: {
  readonly config: ManifestationBudgetConfig;
  readonly onChange: (patch: Partial<ManifestationBudgetConfig["escalation_policy"]>) => void;
}) {
  const { t } = useI18n();
  const policy = props.config.escalation_policy;
  return (
    <>
      <NumberRow label={t("config:budget.nudgePressure")} step={0.05} value={policy.nudge_min_pressure} onChange={(value) => props.onChange({ nudge_min_pressure: value })} />
      <NumberRow label={t("config:budget.nudgeConfidence")} step={0.05} value={policy.nudge_min_confidence} onChange={(value) => props.onChange({ nudge_min_confidence: value })} />
      <NumberRow label={t("config:budget.lensPressure")} step={0.05} value={policy.lens_min_pressure} onChange={(value) => props.onChange({ lens_min_pressure: value })} />
      <NumberRow label={t("config:budget.lensConfidence")} step={0.05} value={policy.lens_min_confidence} onChange={(value) => props.onChange({ lens_min_confidence: value })} />
      <ToggleRow label={t("config:budget.taskCouplingRequired")} value={policy.lens_requires_task_coupling} onChange={(value) => props.onChange({ lens_requires_task_coupling: value })} />
      <ToggleRow label={t("config:budget.governanceCeilingRequired")} value={policy.lens_requires_governance_ceiling} onChange={(value) => props.onChange({ lens_requires_governance_ceiling: value })} />
    </>
  );
}

function BudgetCommitRow(props: {
  readonly dirty: boolean;
  readonly saving: boolean;
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
        disabled={props.saving || !props.dirty}
        className="flex items-center gap-2 px-4 py-2 bg-ink-600 text-beige-50 rounded text-xs font-bold uppercase tracking-widest hover:bg-ink-700 disabled:opacity-40 transition-colors"
      >
        {props.saving ? t("config:action.saving") : <><Save className="w-4 h-4" />{t("config:action.commitBudget")}</>}
      </button>
    </div>
  );
}

function NumberRow(props: {
  readonly label: string;
  readonly value: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <FieldRow label={props.label}>
      <input
        type="number"
        min={0}
        step={props.step ?? 1}
        value={props.value}
        aria-label={props.label}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className="bg-transparent border-b border-beige-300 focus:border-ink-600 outline-none text-sm text-ink-700 font-mono text-right py-1 min-w-[180px]"
      />
    </FieldRow>
  );
}

function ToggleRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <FieldRow label={props.label}>
      <ToggleSwitch
        enabled={props.value}
        label={t("config:field.toggle", { field: props.label })}
        onToggle={() => props.onChange(!props.value)}
      />
    </FieldRow>
  );
}

function LoadingBudget() {
  const { t } = useI18n();
  return (
    <div className="py-4 text-xs text-ink-700/40 uppercase tracking-widest animate-pulse">
      {t("config:loading.manifestationBudget")}
    </div>
  );
}
