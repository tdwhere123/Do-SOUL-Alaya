import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { AlayaError } from "@do-soul/alaya-protocol";

/** Cached vectors are features, not authority to download or invoke a model. */
export async function loadRecallVectorCache(path) {
  const vectors = new Map();
  if (path === undefined) return vectors;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const row = JSON.parse(line), key = `${row.profile_id}\0${row.digest}`;
    if (!Array.isArray(row.v) || !row.v.every(Number.isFinite)) throw new AlayaError("VALIDATION", "invalid cached vector");
    const vector = Float32Array.from(row.v), previous = vectors.get(key);
    if (previous && (previous.length !== vector.length || previous.some((value, index) => value !== vector[index]))) {
      throw new AlayaError("CONFLICT", "conflicting vectors for the same profile and input");
    }
    vectors.set(key, vector);
  }
  return vectors;
}
