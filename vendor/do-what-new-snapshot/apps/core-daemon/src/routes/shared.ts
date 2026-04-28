import { CoreError } from "@do-what/core";

export async function parseJsonBody(readJson: () => Promise<unknown>): Promise<unknown> {
  try {
    return await readJson();
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }
}
