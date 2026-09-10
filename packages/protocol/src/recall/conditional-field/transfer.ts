import { z } from "zod";
import {
  ConditionalFieldIdSchema,
  MilligradeSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  formatConditionalFieldDigest
} from "./common.js";
import { stableCanonicalStringify } from "./product-identity.js";
import { AssociationCapContractSchema, type AssociationCapContract } from "./query.js";

export const HARD_IDENTITY_TRANSFER_ID = "transfer.relation.hard_identity.v1" as const;
export const HARD_IDENTITY_TRANSFER_VERSION = "1" as const;
export const IDENTITY_NORMALIZATION_ID = "identity.unit.v1" as const;

export const TransferDirectionSchema = z.enum(["forward", "reverse"]);

export const FieldGradeSchema = z
  .object({
    milligrades: MilligradeSchema,
    cap_contract_id: Sha256DigestSchema
  })
  .strict()
  .readonly();

export const AdmittedTransferSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    transfer_id: ConditionalFieldIdSchema,
    transfer_version: ConditionalFieldIdSchema,
    query_id: ConditionalFieldIdSchema,
    relation_instance_id: ConditionalFieldIdSchema,
    relation_revision: ConditionalFieldIdSchema,
    direction: TransferDirectionSchema,
    hypothesis_id: ConditionalFieldIdSchema,
    binding: ConditionalFieldIdSchema,
    time_state: ConditionalFieldIdSchema,
    cap_contract: AssociationCapContractSchema,
    milligrades: MilligradeSchema
  })
  .strict()
  .readonly();

export type TransferDirection = z.infer<typeof TransferDirectionSchema>;
export type FieldGrade = z.infer<typeof FieldGradeSchema>;
export type AdmittedTransfer = z.infer<typeof AdmittedTransferSchema>;

export function capContractPreimage(contract: AssociationCapContract): string {
  return stableCanonicalStringify([
    contract.domain_id,
    contract.normalization,
    contract.transfer_id,
    contract.transfer_version
  ]);
}

export function capContractId(
  contract: AssociationCapContract,
  sha256: (preimage: string) => string
): string {
  return formatConditionalFieldDigest(sha256(capContractPreimage(contract)));
}
