import { publishExclusiveOutput } from "../output/exclusive-output.js";

export async function publishExclusiveAuthorization(
  outputPath: string,
  contents: string
): Promise<string> {
  try {
    return await publishExclusiveOutput(outputPath, contents);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("output already exists:")) {
      throw new Error(`authorization output already exists: ${outputPath}`);
    }
    throw error;
  }
}
