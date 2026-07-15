import { createHash } from "node:crypto";

const IDS = Array.from({ length: 500 }, (_, index) => [
  `question-${index + 1}`,
  `q-${index + 1}`
]).flat();

export const VERIFIED_TEST_DATASET_CONTENTS =
  `${JSON.stringify(IDS.map((question_id) => ({ question_id })), null, 2)}\n`;

export const VERIFIED_TEST_DATASET_SHA256 = createHash("sha256")
  .update(VERIFIED_TEST_DATASET_CONTENTS, "utf8")
  .digest("hex");
