export const SELECTION_BOUNDARY_FIDELITY_MISMATCH =
  "selection boundary fidelity mismatch";

// Consumers dispatch on this class; message detail may vary per invariant.
export class SelectionBoundaryFidelityMismatchError extends Error {
  constructor(detail?: string) {
    super(detail === undefined
      ? SELECTION_BOUNDARY_FIDELITY_MISMATCH
      : `${SELECTION_BOUNDARY_FIDELITY_MISMATCH}: ${detail}`);
    this.name = "SelectionBoundaryFidelityMismatchError";
  }
}

export function throwSelectionBoundaryFidelityMismatch(detail?: string): never {
  throw new SelectionBoundaryFidelityMismatchError(detail);
}
