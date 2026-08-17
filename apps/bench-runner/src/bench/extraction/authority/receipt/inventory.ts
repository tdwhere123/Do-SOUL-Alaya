import { assertRepairInventoryProgress } from "../repair/repair-scope.js";

export interface ExtractionAuthorityInventory {
  readonly expectedTurns: number;
  readonly validTurns: number;
  readonly missingTurns: number;
  readonly invalidTurns: number;
  readonly orphanTurns: number;
}

export function assertExtractionAuthorityInventoryProgress(
  authorized: ExtractionAuthorityInventory,
  current: ExtractionAuthorityInventory
): void {
  if (authorized.invalidTurns > 0 &&
      authorized.expectedTurns === authorized.validTurns + authorized.missingTurns +
        authorized.invalidTurns) {
    assertRepairInventoryProgress(authorized, current);
    return;
  }
  if (authorized.invalidTurns !== 0 || authorized.orphanTurns !== 0 ||
      current.invalidTurns !== 0 || current.orphanTurns !== 0) {
    throw new Error("extraction authority receipt cannot authorize invalid or orphan shards");
  }
  if (authorized.expectedTurns !== current.expectedTurns ||
      current.validTurns < authorized.validTurns ||
      current.missingTurns > authorized.missingTurns) {
    throw new Error("extraction authority receipt inventory regressed after inspection");
  }
}
