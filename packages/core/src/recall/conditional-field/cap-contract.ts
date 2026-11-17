import {
  ASSOCIATION_DOMAIN_ID,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  HARD_IDENTITY_TRANSFER_ID,
  HARD_IDENTITY_TRANSFER_VERSION,
  IDENTITY_NORMALIZATION_ID,
  MILLIGRADE_TOP,
  capContractId as protocolCapContractId,
  type AssociationCapContract,
  type ProductStateKey,
  type SeedActivation
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { CoreError } from "../../shared/errors.js";

export const HARD_IDENTITY_CAP_CONTRACT: AssociationCapContract = Object.freeze({
  domain_id: ASSOCIATION_DOMAIN_ID,
  normalization: IDENTITY_NORMALIZATION_ID,
  transfer_id: HARD_IDENTITY_TRANSFER_ID,
  transfer_version: HARD_IDENTITY_TRANSFER_VERSION
});

export function capContractId(contract: AssociationCapContract): string {
  return protocolCapContractId(contract, fieldContractSha256);
}

export function capContractKey(contract: AssociationCapContract): string {
  return [
    contract.domain_id,
    contract.normalization,
    contract.transfer_id,
    contract.transfer_version
  ].join("\0");
}

export function hardIdentityCapContractId(): string {
  return capContractId(HARD_IDENTITY_CAP_CONTRACT);
}

export function isHardIdentityContractId(id: string | undefined): boolean {
  return id === hardIdentityCapContractId();
}

export function normalizeFieldPartitionContract(contract: string | undefined): string {
  // Omission is the legacy numeric coordinate, not evidence of Boolean identity.
  return contract ?? "";
}

export function assertContractGrade(contract: string | undefined, grade: number): void {
  if (isHardIdentityContractId(contract) && grade !== MILLIGRADE_TOP) {
    throw new CoreError("VALIDATION", "Hard identity is Boolean: an admitted activation or transfer must be 1000");
  }
}

/** Hard is a unit; every other coordinate (including untagged numeric) is isolated. */
export function composeCapContracts(contracts: readonly (string | undefined)[]):
  { readonly kind: "compatible"; readonly contract: string } | { readonly kind: "incomparable" } {
  let selected: string | undefined;
  for (const contract of contracts) {
    const normalized = normalizeFieldPartitionContract(contract);
    if (isHardIdentityContractId(normalized)) continue;
    if (selected !== undefined && selected !== normalized) return { kind: "incomparable" };
    selected = normalized;
  }
  return { kind: "compatible", contract: selected ?? hardIdentityCapContractId() };
}

export type ContractGradeSummary = Readonly<{
  hard?: number; coordinate?: string; grade?: number; conflict?: boolean;
}>;

export function joinContractGrade(prior: ContractGradeSummary, contract: string, grade: number): ContractGradeSummary {
  if (isHardIdentityContractId(contract)) return { ...prior, hard: grade };
  return { ...prior, coordinate: contract,
    grade: prior.coordinate === contract ? Math.max(prior.grade ?? -1, grade) : grade,
    conflict: prior.conflict || prior.coordinate !== undefined && prior.coordinate !== contract };
}

export function joinContractSummaries(left: ContractGradeSummary, right: ContractGradeSummary): ContractGradeSummary {
  let merged = left;
  if (right.hard !== undefined) merged = joinContractGrade(merged, hardIdentityCapContractId(), right.hard);
  if (right.coordinate !== undefined && right.grade !== undefined) merged = joinContractGrade(merged, right.coordinate, right.grade);
  return right.conflict ? { ...merged, conflict: true } : merged;
}

export function selectedCapCoordinate(row: ContractGradeSummary): string | undefined {
  if (row.conflict) return row.hard === undefined ? undefined : hardIdentityCapContractId();
  return row.coordinate ?? (row.hard === undefined ? undefined : hardIdentityCapContractId());
}

export function contractScalar(row: ContractGradeSummary): number | undefined {
  // A founded Hard proof is independently selectable even when optional Soft
  // routes have no common coordinate. It does not compare or join those routes.
  return row.hard ?? (row.conflict ? undefined : row.grade);
}

/** Numeric and grounding share this contract+product node id; product identity stays untagged. */
export function fieldPartitionNodeId(productIdentity: string, contract: string | undefined): string {
  return JSON.stringify([normalizeFieldPartitionContract(contract), productIdentity]);
}

export function identitySeedGrade(state: ProductStateKey): SeedActivation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state,
    milligrades: MILLIGRADE_TOP,
    cap_contract_id: hardIdentityCapContractId()
  };
}
