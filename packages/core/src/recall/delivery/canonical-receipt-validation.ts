import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import {
  assertCanonicalSelectionReceiptClosure,
  CANONICAL_SELECTION_RECEIPT_SHAPE_JSON_SCHEMA,
  type CanonicalSelectionReceipt
} from "@do-soul/alaya-protocol";

const validateReceiptShape = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false
}).compile(CANONICAL_SELECTION_RECEIPT_SHAPE_JSON_SCHEMA);

export function assertCanonicalSelectionReceipt<T extends CanonicalSelectionReceipt>(
  receipt: T
): T {
  if (!validateReceiptShape(receipt)) {
    throw new Error(receiptShapeFailure(validateReceiptShape.errors));
  }
  return assertCanonicalSelectionReceiptClosure(receipt);
}

function receiptShapeFailure(errors: readonly ErrorObject[] | null | undefined): string {
  return errors?.map((entry) =>
    `${entry.instancePath || "/"} ${entry.message ?? "is invalid"}`
  ).join("; ") ?? "invalid receipt shape";
}
