import { constants, openSync } from "node:fs";

export function openHeldReserveDescriptor(boundPath: string): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("O_NOFOLLOW is required for semantic artifact reservations");
  }
  return openSync(boundPath, constants.O_RDONLY | constants.O_NOFOLLOW);
}
