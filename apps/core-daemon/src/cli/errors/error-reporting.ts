import { randomUUID } from "node:crypto";
import { AlayaOperationError } from "../operations-types.js";

export type CliFailureCategory = "subcommand" | "bootstrap" | "shutdown";

export function writeCliFailure(
  stream: NodeJS.WritableStream,
  error: unknown,
  category: CliFailureCategory
): void {
  if (error instanceof AlayaOperationError && error.message.trim().length > 0) {
    stream.write(`${error.message.trim()}\n`);
    return;
  }
  stream.write(`CLI failure [category=${category} error_id=${randomUUID()}]\n`);
}
