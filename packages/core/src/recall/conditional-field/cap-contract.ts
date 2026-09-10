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

export function identitySeedGrade(state: ProductStateKey): SeedActivation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state,
    milligrades: MILLIGRADE_TOP,
    cap_contract_id: hardIdentityCapContractId()
  };
}
