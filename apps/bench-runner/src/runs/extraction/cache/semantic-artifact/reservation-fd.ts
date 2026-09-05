import { constants, openSync } from "node:fs";
import { NO_FOLLOW_OPEN_FLAG } from "../../../fs/open-flags.js";

export function openHeldReserveDescriptor(boundPath: string): number {
  return openSync(boundPath, constants.O_RDONLY | NO_FOLLOW_OPEN_FLAG);
}
