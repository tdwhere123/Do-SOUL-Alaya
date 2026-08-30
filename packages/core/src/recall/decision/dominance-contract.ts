import { freezeShadow } from "./contract-primitives.js";

export type PsiQuery = (dominator: string, dominated: string) => boolean;

export type ShadowPsiCycleFailure = Readonly<{
  readonly kind: "psi_cycle_contract_failure";
}>;

export function createPsiCycleFailure(): ShadowPsiCycleFailure {
  return freezeShadow({ kind: "psi_cycle_contract_failure" });
}
