import { readErrorMessage, AlayaError } from "@do-soul/alaya-protocol";
import type {
  MaterializationCreatedObject,
  MaterializationFailureResult,
  MaterializationResult,
  MaterializationResultFields,
  MaterializationSuccessResult
} from "./contracts.js";

export class MaterializationPartialFailureError extends AlayaError {
  public constructor(
    message: string,
    public readonly createdObjects: readonly MaterializationCreatedObject[],
    options?: { readonly cause?: unknown }
  ) {
    super("MATERIALIZATION_PARTIAL_FAILURE", message, options);
    this.name = "MaterializationPartialFailureError";
  }
}

export function materializationSuccess(
  fields: MaterializationResultFields
): MaterializationSuccessResult {
  return { ...fields, success: true };
}

export function materializationFailure(
  fields: MaterializationResultFields,
  error: unknown,
  fallbackMessage = "Unknown materialization error"
): MaterializationFailureResult {
  return {
    ...fields,
    success: false,
    error: readErrorMessage(error, fallbackMessage)
  };
}

export function readPartialFailureCreatedObjects(
  error: unknown
): readonly MaterializationCreatedObject[] {
  // Partial failures may leave created_objects durable while the route still
  // reports failure — callers must reconcile orphans explicitly.
  return error instanceof MaterializationPartialFailureError ? error.createdObjects : [];
}

export function isMaterializationFailure(
  result: MaterializationResult
): result is MaterializationFailureResult {
  return result.success === false;
}
