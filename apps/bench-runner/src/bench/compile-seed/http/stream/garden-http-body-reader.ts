import type { GardenHttpAttemptSettlement } from
  "./garden-http-attempt-settlement.js";
import { releaseGardenHttpReader } from "./garden-http-reader-release.js";

export async function readGardenHttpResponseText(
  response: Response,
  settlement: GardenHttpAttemptSettlement
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return Promise.race([response.text(), settlement.promise]);
  }
  const decoder = new TextDecoder();
  let body = "";
  let completed = false;
  try {
    while (true) {
      const result = await Promise.race([reader.read(), settlement.promise]);
      if (result.done) {
        completed = true;
        return body + decoder.decode();
      }
      settlement.noteProgress();
      body += decoder.decode(result.value, { stream: true });
    }
  } finally {
    releaseGardenHttpReader(reader, completed);
  }
}
