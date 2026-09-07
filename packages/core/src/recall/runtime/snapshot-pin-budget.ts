import { RequestBudgetSchema, SNAPSHOT_PIN_NATIVE_WORK, type RequestBudget } from "@do-soul/alaya-protocol";

export function reserveSnapshotPinWork(budget: RequestBudget): Readonly<{
  budget: RequestBudget;
  permitted: boolean;
}> {
  if (!RequestBudgetSchema.safeParse(budget).success) return { budget, permitted: false };
  const remaining = budget.work_units - SNAPSHOT_PIN_NATIVE_WORK;
  if (remaining < budget.finalization_reserve + budget.min_envelope) {
    return { budget: { ...budget, work_units: 0, min_envelope: Math.max(1, budget.min_envelope) },
      permitted: false };
  }
  return { budget: { ...budget, work_units: remaining }, permitted: true };
}
