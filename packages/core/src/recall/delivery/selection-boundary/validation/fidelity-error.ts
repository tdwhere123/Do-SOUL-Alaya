export const SELECTION_BOUNDARY_FIDELITY_MISMATCH =
  "selection boundary fidelity mismatch";

export function throwSelectionBoundaryFidelityMismatch(): never {
  throw new Error(SELECTION_BOUNDARY_FIDELITY_MISMATCH);
}
